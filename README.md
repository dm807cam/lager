<img src="assets/icon.webp" alt="Lager" width="96" height="96">

# Lager

Lager ist ein selbst gehosteter Server für Claude-Artefakte, also kleine HTML-Apps, die Claude für dich baut. Statt ein Artefakt nur in claude.ai zu behalten, veröffentlicht Claude es auf deinem Server:

- Jede App bekommt eine eigene Subdomain (`<slug>.apps.example.com`).
- Jeder Deploy erzeugt eine nummerierte Version. Du kannst jederzeit auf eine ältere Version zurückgehen.
- Jede App-Instanz hat einen eigenen Datenspeicher (Dokumente mit Live-Updates), den das Artefakt über `claude.use("db")` anspricht. Beim Wechsel der aktiven Version legt Lager vorher einen Schnappschuss der Daten an.
- Mehrere Konten mit Rollen. Zugriff pro Instanz: privat, alle Angemeldeten oder öffentlich, dazu Freigaben für einzelne Konten und Gruppen in vier Stufen.
- Bedient wird Lager über ein Dashboard im Browser, eine REST-API und einen MCP-Endpunkt für Claude.

Lager läuft als ein einzelner Node-Prozess mit SQLite und Dateien in einem Datenverzeichnis. Es gibt keine weiteren Dienste.

## Schnellstart mit Docker

Voraussetzung: Docker mit Compose.

```sh
cp .env.example .env
# .env anpassen: mindestens LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN, LAGER_ADMIN_EMAIL, LAGER_ADMIN_PASSWORD
docker compose up -d --build
```

Der Container lauscht auf Port 8080 und ist nur auf dem Rechner selbst erreichbar (`127.0.0.1:8080`): Davor gehört ein Reverse Proxy mit TLS. Läuft der Proxy auf einem anderen Rechner oder in einem anderen Docker-Netzwerk, ändere in `docker-compose.yml` die Zeile `ports` (zum Beispiel auf `"8080:8080"`) und schütze den Port dann mit einer Firewall, damit niemand Lager am Proxy vorbei erreicht.

Alles wird im benannten Docker-Volume `lager-data` gespeichert. Willst du stattdessen ein Verzeichnis neben der Compose-Datei verwenden, ersetze `"lager-data:/data"` durch `"./data:/data"`, entferne den Abschnitt `volumes:` am Ende und lege das Verzeichnis vorher mit passenden Rechten an, weil der Container als Benutzer `node` (UID 1000) läuft:

```sh
mkdir -p data && sudo chown 1000:1000 data
```

Beim ersten Start entsteht der erste Administrator aus `LAGER_ADMIN_EMAIL` und `LAGER_ADMIN_PASSWORD`. Danach öffnest du `LAGER_PUBLIC_URL` im Browser und meldest dich an. Weitere Konten legst du über Einladungen oder die Registrierung an (siehe „Konten und Rollen“).

Konfiguration (nur Umgebungsvariablen, Vorlage in `.env.example`):

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `LAGER_PUBLIC_URL` | Öffentliche Adresse der Plattform (Login, Dashboard, API, MCP) | Pflicht |
| `LAGER_APPS_DOMAIN` | Domain der Apps; Instanzen laufen unter `<slug>.<Domain>` | Pflicht |
| `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD` | Erster Administrator; wird nur angelegt, solange es noch kein Konto gibt | keins |
| `LAGER_DATA_DIR` | Datenverzeichnis | `./data` (im Container `/data`) |
| `LAGER_PORT` | Port des Servers | `8080` |
| `LAGER_SECRET` | Schlüssel für Sitzungen; sonst erzeugt und in `secret.key` gespeichert | erzeugt |
| `LAGER_SNAPSHOT_KEEP` | Aufbewahrte Daten-Schnappschüsse pro Instanz | `20` |
| `LAGER_SMTP_URL` | SMTP-Zugang für ausgehende Mails, zum Beispiel `smtps://user:passwort@smtp.example.com:465`; ohne Wert kein Mailversand | keins |
| `LAGER_MAIL_FROM` | Absender der Mails | `Lager <no-reply@<Host von LAGER_PUBLIC_URL>>` |
| `LAGER_INSTANCE_QUOTA_MB` | Größe der Daten einer Instanz in MiB, ganze Zahl ab 1 | `50` |
| `LAGER_TRUST_PROXY` | Anzahl der Proxy-Stationen vor Lager, deren `X-Forwarded-*` vertraut wird: `false`/`0` keine, `true` = 1, oder eine Zahl | `true` (1) |

## Konten und Rollen

Lager kennt mehrere Konten. Jedes Konto hat genau eine Rolle:

| Rolle | Darf |
| --- | --- |
| Administrator | Nutzer, Rollen, Einladungen, Gruppen und Einstellungen verwalten, Instanzen deaktivieren, Rücksetz-Links erzeugen; außerdem alles, was ein Publisher darf |
| Publisher | Apps deployen (Dashboard, REST-API, MCP), API-Tokens anlegen, für seine Apps Instanzen auf andere Konten anlegen, Apps mit anderen Publishern oder Administratoren gemeinsam pflegen (Mitarbeit) |
| Nutzer | Instanzen öffnen, die für ihn freigegeben sind oder allen Angemeldeten offenstehen; eigene Instanzen von Apps anlegen, die Selbstbedienung erlauben |

Wie ein Konto entsteht, hängt vom Registrierungsmodus ab. Ihn stellt ein Administrator unter „Verwaltung → Einstellungen“ ein:

- **Offen:** Jeder kann sich unter `/register` ein Konto als Nutzer anlegen.
- **Nur mit Einladung:** Registrieren geht nur über einen Einladungslink.
- **Geschlossen:** Niemand kann sich registrieren; auch Einladungslinks gelten dann nicht.

Der Standard hängt vom Mailversand ab: Ist `LAGER_SMTP_URL` gesetzt, ist die Registrierung offen, sonst nur mit Einladung. Hat ein Administrator den Modus einmal gespeichert, gilt seine Wahl.

Einladungen erstellt ein Administrator unter „Verwaltung → Einladungen“, mit einer Rolle und optional einer E-Mail-Adresse, an die der Link gebunden ist. Der Link ist 7 Tage gültig und funktioniert einmal. Wer über ihn ein Konto anlegt, ist sofort angemeldet. Passwörter brauchen mindestens 10 Zeichen.

Den ersten Administrator legt Lager beim Start aus `LAGER_ADMIN_EMAIL` und `LAGER_ADMIN_PASSWORD` an, aber nur, solange es noch gar kein Konto gibt. Weitere Administratoren ernennst du über die Rolle eines bestehenden Kontos. Der letzte aktive Administrator lässt sich weder herabstufen noch deaktivieren. Ein deaktiviertes Konto kann sich nicht mehr anmelden, und seine Sitzungen auf Plattform und Instanzen enden sofort.

Administratoren haben keinen Zugriff auf die Daten fremder Instanzen. Sie sehen in der Verwaltung, welche Apps und Instanzen es gibt, wem sie gehören und wie viel Speicher sie belegen, und können eine Instanz deaktivieren. Eine private Instanz eines anderen Kontos öffnen sie nicht, und Daten lesen sie nur, wenn man ihnen eine Stufe freigegeben hat wie jedem anderen Konto.

## Mailversand

Lager verschickt Mails für die Bestätigung der E-Mail-Adresse, das Zurücksetzen von Passwörtern und Einladungen mit angegebener Adresse. Dafür setzt du zwei Variablen:

```sh
LAGER_SMTP_URL=smtps://lager%40example.com:geheim@smtp.example.com:465
LAGER_MAIL_FROM=Lager <lager@example.com>
```

Sonderzeichen in Benutzername und Passwort der URL musst du prozentcodieren (`@` wird `%40`). Fehlt `LAGER_MAIL_FROM`, ist der Absender `Lager <no-reply@<Host von LAGER_PUBLIC_URL>>`. Schlägt der Versand fehl, schreibt Lager den Fehler ins Log und zeigt den Nutzern keine Fehlermeldung.

Ohne `LAGER_SMTP_URL` läuft Lager vollständig, nur ohne Mails:

- E-Mail-Adressen werden nicht bestätigt; neue Konten sind sofort nutzbar. Die Registrierung steht deshalb standardmäßig auf „Nur mit Einladung“.
- Einladungen funktionieren: Der Link wird dem Administrator einmal in der Verwaltung angezeigt, und er gibt ihn selbst weiter.
- „Passwort vergessen“ verschickt nichts. Ein Administrator erzeugt stattdessen unter „Verwaltung → Nutzer“ einen Rücksetz-Link (1 Stunde gültig, einmal verwendbar) und gibt ihn weiter.

Schaltest du den Mailversand später ein, bleiben bestehende Konten bestätigt.

## Teilen

Es gibt zwei Arten, eine App mit anderen zu nutzen:

- **Dieselbe Instanz:** Alle arbeiten in denselben Daten. Der Besitzer der Instanz gibt sie frei: für einzelne Konten (über E-Mail-Adresse), für Gruppen, oder über die Sichtbarkeit für alle Angemeldeten oder öffentlich. Das geht auf der Instanzseite im Dashboard, über `PUT /api/instances/<slug>/grants` mit `{"email": …, "level": …}` oder `{"group": …, "level": …}` und über die MCP-Werkzeuge `share_instance`, `unshare_instance` und `list_shares`.
- **Eigene Instanz:** Jeder bekommt eine eigene Instanz derselben App mit getrennten Daten. Ein Publisher kann Instanzen für andere Konten anlegen. Außerdem kann der Besitzer einer App unter „App → Selbstbedienung“ erlauben, dass alle Angemeldeten selbst eine Instanz anlegen; sie finden die App dann im Katalog auf ihrer Übersichtsseite und sind Besitzer ihrer Instanz.

Die Stufen auf einer Instanz:

| Stufe | Darf |
| --- | --- |
| Betrachter (`view`) | Die App öffnen und Daten lesen |
| Mitwirkender (`interact`) | zusätzlich Daten schreiben, soweit die Regeln der App es erlauben |
| Verwalter (`admin`) | zusätzlich Freigaben, Sichtbarkeit, Versionen und Schnappschüsse verwalten |
| Besitzer (`owner`) | alles, außerdem die Instanz löschen; nicht vergebbar |

Bei mehreren Wegen zur selben Instanz (direkte Freigabe, Gruppe, Sichtbarkeit „Alle Angemeldeten“) gilt die höchste Stufe. Bei „Alle Angemeldeten“ stellt der Besitzer ein, ob diese Konten Betrachter oder Mitwirkende sind (Standard: Mitwirkende). Ohne App-Regeln lesen alle ab Betrachter und schreiben ab Mitwirkender; öffentliche Besucher können nie schreiben.

Gruppen legen Administratoren unter „Verwaltung → Gruppen“ an und füllen sie mit Konten. Eine Freigabe an eine Gruppe gilt für alle ihre Mitglieder.

Eine App selbst, also ihre Versionen, sehen und verändern nur ihr Besitzer und die Mitarbeiter, die er auf der App-Seite hinzufügt (Administratoren oder Publisher).

## Grenzen

- **Speicher pro Instanz:** Die Daten einer Instanz sind auf `LAGER_INSTANCE_QUOTA_MB` begrenzt (Standard 50 MiB). Ist die Grenze erreicht, lehnt Lager weitere Schreibzugriffe mit dem Fehler `quota_exceeded` (HTTP 507) ab; Lesen und Löschen funktionieren weiter. Die Grenze gilt für die Daten, nicht für die Versionen der App.
- **Instanzen pro Nutzer:** Jedes Konto, das kein Administrator ist, darf höchstens so viele Instanzen besitzen, wie ein Administrator unter „Verwaltung → Einstellungen“ festlegt (1 bis 1000, Standard 20). Das gilt beim Anlegen weiterer Instanzen, auch bei Selbstbedienung.

## Löschen und Papierkorb

Löscht der Besitzer eine Instanz oder eine App im Dashboard, entfernt Lager sie aus der Plattform, verschiebt die Dateien aber nur in `<Datenverzeichnis>/trash` (im Container `/data/trash`): die Daten einer Instanz als `<Instanz-ID>-<Zeitstempel>`, die Versionen einer App als `app-<App-ID>-<Zeitstempel>`. Lager räumt dieses Verzeichnis nie auf und bietet keine Wiederherstellung dafür. Du leerst es von Hand, sobald du die Daten nicht mehr brauchst; ein Rückholen geht nur durch Kopieren der Dateien. Eine App lässt sich nur löschen, solange keine fremden Instanzen von ihr existieren.

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

Alles liegt im Datenverzeichnis (bei Docker Compose das Volume `lager-data`, bei einem Bind-Mount `./data`): Datenbank der Plattform, alle Versionen, die Daten und Schnappschüsse der Instanzen und `secret.key`. Zum Sichern den Dienst stoppen und das Volume beziehungsweise Verzeichnis kopieren. Mit dem Volume (Compose-Projektname `lager`, sonst `<Verzeichnisname>_lager-data`; `docker volume ls` zeigt ihn):

```sh
docker compose stop
docker run --rm -v lager_lager-data:/data -v "$PWD":/backup alpine tar czf /backup/lager-backup-$(date +%F).tgz -C /data .
docker compose start
```

Bei einem Bind-Mount genügt `cp -a data data-backup-$(date +%F)`.

Zum Wiederherstellen den Inhalt zurückkopieren (beziehungsweise das Archiv in ein leeres Volume entpacken). Behalte `secret.key` (oder `LAGER_SECRET`), sonst werden alle Sitzungen ungültig.

## Was Lager nicht kann

- Keine Anmeldung über externe Anbieter (Single Sign-on); Konten haben E-Mail und Passwort.
- Der Quota gilt nur für die Daten einer Instanz, nicht für Versionen, Schnappschüsse oder den Papierkorb. Eine Begrenzung für die Gesamtgröße gibt es nicht.
- Der Papierkorb wird nicht automatisch geleert und lässt sich nicht über Lager wiederherstellen.
- Keine Capabilities außer `db` und `user`; alle anderen liefern `null`.
- Kein eigenes TLS: HTTPS übernimmt der vorgeschaltete Proxy.
- Keine automatische Datensicherung und keine Replikation.
