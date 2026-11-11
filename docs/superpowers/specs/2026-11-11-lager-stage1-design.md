# Lager – Stufe 1 (Kern): Design

Lager ist eine selbst gehostete Plattform, auf die Claude seine Artefakte (kleine HTML-Web-Apps) deployt. Vorbild ist Posit Connect; Unterschied: Lager bringt persistenten Speicher pro App-Instanz mit und bildet die Laufzeit-Schnittstelle der Claude-Artefakte (`claude.use(...)`) nach.

## Warum

- **Besitz:** Apps und Daten liegen auf eigener Infrastruktur und laufen ohne Claude weiter.
- **Versionierung:** Jedes Deployment bleibt erhalten; Zurückrollen jederzeit.
- **Persistenz:** Daten überleben jeden Codewechsel. Nichts Dauerhaftes im Browser.
- **Nahtlos:** Claude baut Artefakte wie gewohnt und pusht sie per MCP.

## Umfang Stufe 1

Enthalten: Deploy per MCP und REST, Versionen mit Zurückrollen, Auslieferung auf Subdomains, Dokumenten-Speicher pro Instanz mit Zugriffsregeln und Live-Updates, Nutzerkennung, Schnappschüsse, ein Admin-Konto, minimales Dashboard, Docker-Betrieb, Skill.

Nicht enthalten (Stufe 2/3): Selbstregistrierung, Rollenverwaltung im UI, Freigabe an einzelne Nutzer/Gruppen, Uploads (`assets`), Echtzeit (`room`), `artifact`-Selbstpublikation, `sample`, eigene Domains pro Instanz, Import bestehender Artefakte.

Anti-Ziele: kein eigener Reverse-Proxy, kein Container pro App, keine nativen Abhängigkeiten, kein externer Datenbankserver.

## Begriffe

- **App:** ein Artefakt mit Slug, Titel, Besitzer und nummerierten **Versionen** (1, 2, …). Eine Version ist eine HTML-Datei plus Capabilities-Deklaration.
- **Instanz:** eine laufende Ausprägung einer App mit eigener Subdomain, eigenem Datenbestand und einem Zeiger `activeVersion`. Beim ersten Deploy entsteht eine Standard-Instanz mit dem Slug der App. Weitere Instanzen derselben App haben getrennte Daten.
- **Daten gehören zur Instanz, nie zur Version.** Ein Versionswechsel ändert nur den Zeiger.

## Verhalten

### Deploy und Versionen
- Deploy auf neuen Slug legt App, Version 1 und Standard-Instanz an. Deploy auf bestehenden Slug legt die nächste Version an und aktiviert sie auf allen Instanzen der App mit `autoUpdate` (Standard: an).
- Identischer Inhalt wie die neueste Version (gleicher SHA-256, gleiche Capabilities) erzeugt keine neue Version.
- Nur Besitzer der App dürfen deployen; Deploy setzt Rolle `admin` oder `publisher` voraus.
- Aktivieren einer beliebigen vorhandenen Version ist jederzeit möglich (Zurück- und Vorrollen).
- Deploy-Prüfung warnt (blockiert nicht), wenn das HTML `localStorage`, `sessionStorage` oder `indexedDB` benutzt.

### Persistenz
- Pro Instanz eine SQLite-Datei unter `<dataDir>/instances/<instanceId>/data.sqlite`.
- Vor jedem Wechsel von `activeVersion` wird automatisch ein Schnappschuss der Instanz-Daten angelegt (sofern Daten existieren). Aufbewahrt werden die letzten `LAGER_SNAPSHOT_KEEP` (Standard 20).
- Wiederherstellen eines Schnappschusses sichert zuvor den aktuellen Stand als weiteren Schnappschuss.
- Sämtlicher Zustand liegt unter `dataDir` (ein Docker-Volume); Sichern = Verzeichnis kopieren.

### Adressen und Proxy
- Ein HTTP-Dienst auf einem Port. Unterscheidung nur über den Hostnamen:
  - Plattform (Login, Dashboard, REST, MCP, OAuth): Hostname aus `LAGER_PUBLIC_URL`.
  - Instanz: `<slug>.<LAGER_APPS_DOMAIN>`.
- Der Dienst vertraut `X-Forwarded-*` (abschaltbar). TLS macht der vorgeschaltete Proxy. Voraussetzung: Wildcard-DNS und Wildcard-Zertifikat für `*.<LAGER_APPS_DOMAIN>`.
- Lokal: `LAGER_PUBLIC_URL=http://lager.localhost:8080`, `LAGER_APPS_DOMAIN=apps.localhost`.

### Anmeldung und Isolation
- Stufe 1 kennt genau ein Konto, das beim ersten Start aus `LAGER_ADMIN_EMAIL`/`LAGER_ADMIN_PASSWORD` entsteht (Rolle `admin`). Das Schema trägt bereits Rollen `admin|publisher|user`.
- Plattform-Sitzung: Cookie nur für den Plattform-Host.
- Jede Instanz hat ein eigenes, nur für ihren Host gültiges Sitzungs-Cookie. Es entsteht über einen Umleitungs-Handshake: Instanz → Plattform (`/auth/instance`) → einmaliger, 60 s gültiger Code → Instanz (`/__lager/callback`). Ein Cookie oder Code für Instanz A ist auf Instanz B und auf der Plattform wertlos.
- Sichtbarkeit pro Instanz: `private` (nur Besitzer), `users` (alle Angemeldeten), `public` (ohne Login). Standard `private`.
- Zugriffsstufe eines Betrachters: Besitzer der Instanz → `owner`; sonst bei `users` und angemeldet → `interact`; bei `public` → `view` (auch anonym); sonst kein Zugriff. Plattform-Admins erhalten auf fremden Instanzen keine Sonderrechte.

### Laufzeit-Schnittstelle im Browser
- Beim Ausliefern fügt Lager `<script src="/__lager/runtime.js"></script>` als erstes Skript in die Seite ein.
- `window.claude.use(name)` liefert ein Promise auf den Namensraum oder `null`:
  - `db`: Dokumenten-Datenbank nach dem Vertrag der Claude-Artefakte (`doc`, `collection`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot`, `acquire`).
  - `user`: `isOwner`, `canEdit`, `can`, `id`, `me`, `name`, `email`, `avatarUrl`, `profiles`, `search`.
  - `permissions`: `state`, `request`, `manage` (alles gilt als gewährt).
  - alles andere: `null`.
- Kompatibilität für Artefakte aus dem claude.ai-Chat (Signaturen dort nicht offiziell dokumentiert, daher bestmöglich): `window.storage.get/set/delete/list(key|prefix, shared)`, abgebildet auf den Dokumenten-Speicher. `window.claude.complete` lehnt mit klarer Fehlermeldung ab.

### Zugriffsregeln der Datenbank
- Stufen: `view < interact < admin < owner`; zusätzlich `self` (hält niemand).
- Standard ohne Regeln: lesen ab `view`, schreiben ab `interact`.
- Regeln aus `capabilities.db.rules` (`{path, read?, write?}`) setzen Mindeststufen pro Pfad-Präfix; die spezifischste passende Regel gewinnt; das Segment `{self}` passt nur auf die ID des Betrachters.
- `data/users/<id>/…` ist immer nur für Nutzer `<id>` lesbar und schreibbar, auch nicht für den Besitzer.
- Anonyme Betrachter schreiben nie.
- Grenzen: Segment ≤ 200 Byte, Pfad ≤ 16 Segmente und ≤ 1000 Byte, Dokument ≤ 256 KiB und ≤ 32 Ebenen.

### Claude-Anbindung
- Remote-MCP-Server (Streamable HTTP) unter `<LAGER_PUBLIC_URL>/mcp`.
- Authentifizierung: OAuth 2.1 mit dynamischer Client-Registrierung und PKCE (für claude.ai und Desktop-App) sowie statische API-Tokens `lgr_…` als Bearer (für Claude Code und Skripte).
- Werkzeuge: `deploy_app`, `list_apps`, `get_app`, `activate_version`, `create_instance`, `set_visibility`, `db_read`, `db_write`, `list_snapshots`, `restore_snapshot`, `get_guide`.
- REST-Deploy `PUT /api/apps/:slug` nimmt die HTML-Datei direkt entgegen, damit Claude Code die Datei hochlädt, statt ihren Inhalt erneut als Werkzeug-Argument zu senden.
- Die Bauanleitung (`src/guide.md`) wird als MCP-`instructions`, über `get_guide` und als Skill (`skill/lager/SKILL.md`) ausgeliefert.

### Dashboard
Server-gerenderte Seite auf dem Plattform-Host (deutsch): Apps und Instanzen mit Link, Sichtbarkeit, aktiver Version, Versionsliste mit „Aktivieren", Schnappschüsse mit „Wiederherstellen", API-Tokens, Connector-Adresse.

## Technik (Entscheidungen des Entwurfs, nicht vom Auftraggeber vorgegeben)

- Node.js ≥ 22.13, TypeScript (strict, ESM), Express 5, eingebautes `node:sqlite`, `@modelcontextprotocol/sdk`, `zod`. Tests mit Vitest und Supertest.
- Ein Docker-Image (`node:24-slim`, nicht als root), `docker-compose.yml` mit einem Volume.
- Konfiguration nur über Umgebungsvariablen: `LAGER_PUBLIC_URL`, `LAGER_APPS_DOMAIN`, `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD`, `LAGER_DATA_DIR` (Standard `/data`), `LAGER_PORT` (8080), `LAGER_SECRET` (sonst erzeugt und unter `dataDir` gespeichert), `LAGER_SNAPSHOT_KEEP` (20), `LAGER_TRUST_PROXY` (true).
- Fehlerform aller JSON-Schnittstellen: `{"error":{"code","message"}}`.
- Oberfläche deutsch; Code, Bezeichner und Kommentare englisch.
