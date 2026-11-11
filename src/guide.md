Lager ist ein selbst gehosteter Server für Claude-Artefakte: Jede App bekommt eine eigene Subdomain, nummerierte Versionen mit Zurückrollen und einen dauerhaften Datenspeicher pro Instanz.
Baue das Artefakt genau wie ein Claude-Artefakt: eine einzige HTML-Datei, Skripte und Styles inline oder von einem CDN.
Dauerhafte Daten nur über `const db = await claude.use("db")` – niemals `localStorage`, `sessionStorage` oder `indexedDB`, die gehen beim Gerätewechsel verloren.
Angaben zum Nutzer liefert `await claude.use("user")`.
Gib beim Deploy die `capabilities` an, die das Artefakt nutzt, meist `{"db": {}, "user": {}}`.
Deploye mit dem Werkzeug `deploy_app` (slug, html, title, capabilities, note), statt ein claude.ai-Artefakt zu veröffentlichen.
Hast du eine Shell und ein `LAGER_TOKEN`, lade die Datei direkt hoch, statt ihren Inhalt als Argument zu senden:
`curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" --data-binary @index.html "<Lager-Adresse>/api/apps/<slug>?title=...&capabilities=..."`
Nenne dem Nutzer danach die zurückgegebene URL und jede Warnung aus `warnings`.
Teilen: dieselbe Instanz mit `share_instance` (gemeinsame Daten) oder eine eigene Instanz mit `create_instance` (getrennte Daten); der Abschnitt „Teilen und Instanzen" in `get_guide` erklärt den Unterschied.
Soll ein vorhandenes claude.ai-Artefakt hierher umziehen: erst `check_artifact`, dann dem Abschnitt „Bestehende Artefakte übernehmen“ in `get_guide` folgen.
Einzelheiten (Regeln, Grenzen, Versionen, Instanzen, Daten vorbefüllen): Werkzeug `get_guide`.

---

# Lager – Anleitung für Claude

## Capabilities

`window.claude.use(name)` liefert ein Promise auf einen Namensraum oder `null` und wirft nie. Ein Namensraum erscheint nur, wenn die aktive Version ihn in `capabilities` deklariert; Namen, die Lager nicht kennt, liefern immer `null`. Deklariere deshalb jeden benutzten Namensraum und prüfe das Ergebnis auf `null`; `check_artifact` zeigt vor dem Deploy, was fehlt.

- `db` (`{"db": {}}`, Regeln in `db.rules`) – Dokumenten-Datenbank nach dem Vertrag der Claude-Artefakte: `db.collection("tasks")`, `db.doc("tasks/t1")`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot` (Live-Updates), `acquire` (Sperre mit Ablaufzeit). `null` ohne Zugriffsstufe auf die Instanz.
- `user` (`{"user": {}}`) – `id`, `name`, `email` (nur mit `user: {scopes: ["email"]}`), `isOwner`, `canEdit`, `can`, `me`, `profiles`, `search`, `avatarUrl`. `search` braucht `user: {scopes: ["profile"]}`. Jedes Mitglied von `user` ist eine asynchrone Funktion, auch `name`: `const name = await user.name();`.
- `permissions` (keine Deklaration nötig) – `state`, `request`, `manage`; zeigt die verfügbaren Namensräume als gewährt, alles andere als `unavailable`.
- `assets` (`{"assets": {}}`) – `upload(blob, {type?})`, `list()`, `delete(idOrUrl)`; Dateien liegen unter `/_blob/<id>` und zählen zum Speicher der Instanz. Hochladen dürfen Verwalter und Besitzer; mit `{"assets": {"upload": "interact"}}` auch Mitwirkende. Sonst `null`. Grenzen: 20 MiB je Datei (CSS und JavaScript 16 MiB, SVG 2 MiB), höchstens 2000 Dateien je Instanz; erlaubt sind Bilder, Video, Audio, PDF, Schriften, CSS, JavaScript, CSV, Markdown, JSON und Text.
- `room` (`{"room": {}}`, optional `{"topics": {"<Thema>": "interact"}}`) – flüchtige Räume mit Nachrichten und Anwesenheit, nur im Arbeitsspeicher, ohne Verlauf: `room.join(name)` liefert ein Raumobjekt mit `emit(topic, data)`, `on(topic, handler)`, `presence(patch)`, `peers()`, `onPeers`, `connected`, `onConnection`, `leave()`. Senden dürfen Verwalter und Besitzer auf jedem Thema, Mitwirkende nur auf Themen, die mit `"interact"` deklariert sind; Betrachter hören nur zu. `null` ohne Zugriffsstufe. Grenzen: Raumname `^[a-z0-9][a-z0-9_.-]{0,47}$`, Thema `^[a-z][a-z0-9_.-]{0,47}$`, Nachricht höchstens 4 KiB JSON und 8 Ebenen tief, Anwesenheit höchstens 2 KiB, höchstens 16 benannte Räume je Seite.
- `artifact` oder `self` (gleichwertig; `{"artifact": {}}`, mit `{"publish": false}` gesperrt) – die Seite speichert sich selbst: `artifact.publish(html)` (ein vollständiges Dokument, das mit `<!doctype html` beginnt) legt eine neue Version an, die nur dieser Instanz gehört und sofort dort aktiv ist. Nur Verwalter und Besitzer dürfen speichern; höchstens 16 MiB, 60 Speicherungen pro Stunde und Instanz, die letzten 20 gespeicherten Versionen bleiben erhalten. `publish` mit mehreren Dateien sowie `edit`, `sync` und `metadata` lehnen mit einem Fehlercode ab. Bei `null` fehlt die Deklaration.
- `downloads` (`{"downloads": {}}`) – `downloads.save({filename, data})` bietet dem Betrachter nach seiner Bestätigung eine Datei zum Speichern an. Erlaubte Endungen: gif, png, jpg, jpeg, webp, mp4, webm, mov, txt, json, md, docx, pptx, epub, csv, ttf, html, svg, pdf, xlsx, zip, fig; höchstens 50 MiB.
- Alles andere (z. B. `sample`, `tts`) liefert `null`. Baue das Artefakt so, dass es ohne diese Namensräume funktioniert: prüfe auf `null` und blende die Funktion aus.

`window.claude.complete` gibt es nicht; der Aufruf lehnt mit einer Fehlermeldung ab.

## Zugriffsregeln der Datenbank

Stufen: `view < interact < admin < owner`, dazu `self` (hält niemand für sich allein). Wer was erreicht: Besitzer der Instanz → `owner`; wer per Freigabe (`share_instance`, einzeln oder über eine Gruppe) eine Stufe hält → diese Stufe, bei mehreren Wegen die höchste; bei Sichtbarkeit `users` jeder Angemeldete → die Stufe für Angemeldete (Standard `interact`, siehe `list_shares`); bei `public` auch Anonyme → `view`.

Ohne Regeln: lesen ab `view`, schreiben ab `interact`. Anonyme schreiben nie.

Regeln stehen in `capabilities.db.rules` als `{path, read?, write?}` und setzen Mindeststufen pro Pfad-Präfix. Die spezifischste passende Regel gewinnt. Das Segment `{self}` passt nur auf die ID des Betrachters.

Beispiel Abstimmung – jeder darf nur seine eigene Stimme schreiben, der Besitzer alle:

```json
{"db": {"rules": [
  {"path": "votes", "read": "view", "write": "owner"},
  {"path": "votes/{self}", "write": "interact"}
]}}
```

Beispiel Abzeichnen – jeder zeichnet nur für sich selbst ab, auch der Besitzer kann nicht für andere unterschreiben:

```json
{"db": {"rules": [
  {"path": "signoffs", "read": "view", "write": "self"},
  {"path": "signoffs/{self}", "read": "view", "write": "interact"}
]}}
```

`data/users/<id>/…` gehört immer nur Nutzer `<id>` – lesen und schreiben, auch nicht für den Besitzer, und Regeln können das nicht lockern. Dort liegen private Einstellungen und Entwürfe.

## Grenzen

- Pfad: höchstens 16 Segmente, jedes höchstens 200 Byte, keine leeren Segmente.
- Dokumentpfade haben eine gerade Zahl von Segmenten (`tasks/t1`), Sammlungspfade eine ungerade (`tasks`).
- Dokument: höchstens 256 KiB als JSON und 32 Ebenen tief; Zahlen müssen endlich sein.
- Abfragen: höchstens 1000 Treffer.
- HTML: höchstens 16 MiB.
- Import: REST höchstens 50 MiB und 100000 Dokumente je Aufruf, `import_data` höchstens 1000 Dokumente; `export_data` liefert standardmäßig 200, höchstens 1000 Dokumente.

## Versionen und Zurückrollen

Jeder Deploy mit geändertem Inhalt oder geänderten Capabilities erzeugt die nächste Version und aktiviert sie auf allen Instanzen mit automatischer Aktualisierung. Gleicher Inhalt erzeugt keine neue Version (`createdVersion: false`).

- `get_app {slug}` zeigt alle Versionen und Instanzen.
- `activate_version {instance, version}` aktiviert eine beliebige vorhandene Version – zurück und vor.
- Vor jedem Versionswechsel legt Lager automatisch einen Schnappschuss der Instanz-Daten an. `list_snapshots {instance}` zeigt sie, `restore_snapshot {instance, snapshot}` stellt einen wieder her (der aktuelle Stand wird vorher gesichert).

Daten gehören zur Instanz, nie zur Version: Ein neuer Code muss mit den vorhandenen Daten zurechtkommen. Ändere Datenformate abwärtsverträglich (fehlende Felder mit Standardwerten lesen).

## Teilen und Instanzen

Der erste Deploy legt die Standard-Instanz mit dem Slug der App an (Sichtbarkeit `private`). Instanz-Slugs sind global eindeutig. Es gibt zwei Arten zu teilen; wähle nach der Frage, ob die Beteiligten dieselben Daten sehen sollen.

**Dieselbe Instanz – gemeinsame Daten** (Abstimmung, Familienliste, Teamboard):
- `share_instance {instance, email? | group?, level}` gibt einem Konto (E-Mail) oder einer Gruppe (Name) Zugriff oder ändert die Stufe; genau eines von `email` und `group`. `unshare_instance {instance, email? | group?}` nimmt den Zugriff zurück, `list_shares {instance}` zeigt Freigaben, `visibility` und `usersLevel`.
- Stufen: `view` (Betrachter: ansehen), `interact` (Mitwirkender: auch Daten schreiben, soweit die Regeln der App es erlauben), `admin` (Verwalter: zusätzlich Freigaben, Versionen, Sichtbarkeit und Daten verwalten). `owner` (Besitzer) kann nicht vergeben werden; er legt auch die Instanz an und löscht sie.
- `set_visibility {instance, visibility}`: `private` (nur Besitzer und Freigegebene), `users` (alle Angemeldeten) oder `public` (ohne Anmeldung).
- Das Konto muss existieren. Wer noch keins hat, muss vom Administrator eingeladen werden; sage das dem Nutzer, statt eine Freigabe zu erfinden.

**Eigene Instanz – getrennte Daten** (jeder soll seine eigene Kopie, etwa ein Trainingstagebuch pro Person):
- `create_instance {app, slug, visibility?, owner_email?}` legt eine weitere Instanz mit eigener Subdomain und eigenen Daten an. Mit `owner_email` gehört sie dem Konto mit dieser Adresse (nur, wer die App deployen darf); ohne gehört sie dem Aufrufer. Für Nutzer ohne Deploy-Recht geht es nur, wenn der Besitzer der App Selbstbedienung erlaubt hat; sonst antwortet Lager mit `forbidden`.
- Per Shell: `GET|PUT|DELETE /api/instances/<slug>/grants` (Körper `{email|group, level}`) und `POST /api/apps/<slug>/instances` (Körper `{slug, ownerEmail?, visibility?}`) mit demselben Bearer-Token.

**Eigene Domain:** `add_domain {instance, host}` und `remove_domain {instance, host}` lassen eine Instanz zusätzlich unter einem eigenen Hostnamen antworten (per Shell `GET|PUT|DELETE /api/instances/<slug>/domains`, Körper `{host}`). Das dürfen Administratoren, und Publisher, die die Instanz verwalten, nur wenn der Administrator es erlaubt hat; sonst antwortet Lager mit `forbidden`. DNS, Proxy-Eintrag und Zertifikat richtet der Nutzer selbst ein, Lager prüft nicht, wem die Domain gehört. Die erste URL bleibt die Adresse unter der Apps-Domain.

Der Speicher einer Instanz ist begrenzt (Standard 50 MB). Ist er voll, lehnen Schreibzugriffe mit dem Fehlercode `quota_exceeded` ab; dann Daten löschen oder dem Nutzer Bescheid geben. `db_write` führt die Operationen nacheinander aus; scheitert eine mittendrin, nennt die Fehlermeldung, wie viele vorher schon angewendet wurden.

`user.search(q)` im Artefakt (Personenwahl, `@`-Erwähnung) findet Besitzer und Freigegebene der eigenen Instanz und braucht `user: {scopes: ["profile"]}`; höchstens 8 Treffer, bei fehlendem Scope oder ohne Anmeldung `[]`. Speichere nur `id`, nie den Namen; E-Mail-Adressen kommen nur mit zusätzlichem Scope `"email"`.

## Daten vorbefüllen

Schreibe Start- und Beispieldaten nicht fest ins HTML, sondern lege sie nach dem Deploy mit `db_write` an:

```json
{"instance": "todo", "ops": [
  {"op": "set", "path": "tasks/t1", "data": {"title": "Erste Aufgabe", "done": false}},
  {"op": "update", "path": "settings/main", "data": {"theme": "hell"}}
]}
```

Mehr Dokumente auf einmal (Umzug, Sicherung) schreibt `import_data`, siehe unten. Höchstens 100 Operationen pro Aufruf (`set` ersetzt, `update` führt zusammen, `delete` löscht). `db_read {instance, path, where?, orderBy?, limit?}` liest ein Dokument (`{doc}`) oder eine Sammlung (`{docs}`). Beide handeln mit deiner eigenen Stufe auf der Instanz: der Besitzer ohne die Regeln der App, ein Verwalter nach den Regeln der App (Regeln, die `owner` verlangen, bleiben ihm verschlossen). Private Bereiche anderer Nutzer bleiben immer gesperrt.

## Kompatibilität mit `window.storage`

Artefakte aus dem claude.ai-Chat, die `window.storage.get/set/delete/list(key | prefix, shared)` benutzen, laufen weiter: Mit `shared = true` landen die Werte in der Sammlung `kv` (für alle Betrachter der Instanz), sonst unter `data/users/<id>/storage/kv/<key>` (nur für den Betrachter); geteilte Werte liegen unter `kv/<key>`. Werte sind Zeichenketten. Ein gelöschtes Dokument nimmt seine Unter-Sammlungen nicht mit: `delete` entfernt nur das Dokument selbst. Für neue Artefakte ist `claude.use("db")` die bessere Wahl.

## Bestehende Artefakte übernehmen

Ein vorhandenes Artefakt (aus dem claude.ai-Chat oder von anderswo) zieht so um:

1. **Quelltext lesen.** Hole das vollständige HTML des bestehenden Artefakts. Bei einer früheren Lager-Version lädt der Nutzer es unter „HTML“ in der Versionsliste herunter (`GET /api/apps/<slug>/versions/<n>`).
2. **Prüfen.** `check_artifact {html, capabilities?}` (oder `POST /api/check`) nennt `used` (benutzte Namensräume), `unsupported` (Namensräume, die Lager nicht bietet und die `null` liefern), `undeclared` (benutzt, aber nicht deklariert) und `warnings` (Browser-Speicher, `claude.complete`).
3. **Ersetzen.** Baue alles um, was `unsupported` nennt: prüfe auf `null` und blende die Funktion aus oder ersetze sie. `localStorage`, `sessionStorage` und `indexedDB` wechseln zu `claude.use("db")`; `window.storage` läuft unverändert weiter (siehe unten), `claude.complete` gibt es nicht. Sage dem Nutzer, welche Funktionen dadurch entfallen.
4. **Deklarieren.** Trage jeden benutzten Namensraum in `capabilities` ein (`db`, `user`, `assets`, `room`, `artifact`, `downloads`; `permissions` braucht nichts), samt Regeln und Scopes. Prüfe noch einmal mit `check_artifact`, bis `undeclared` und `unsupported` leer sind.
5. **Deployen.** `deploy_app`; nenne dem Nutzer die URL und alle Warnungen.
6. **Daten übernehmen.** Lies die Daten mit den Mitteln der alten Umgebung aus und schreibe sie mit `import_data {instance, docs: [{path, data}]}` (höchstens 1000 Dokumente je Aufruf, in Teilen wiederholbar; vorhandene Dokumente werden ersetzt). Per Shell geht `POST /api/instances/<slug>/import` mit Körper `application/x-ndjson` (eine Zeile `{"path":…,"data":…}` je Dokument) oder einem JSON-Array. Lebt der Bestand nur im Browser des Nutzers, baue in das alte Artefakt einmalig eine Schaltfläche „Daten exportieren“, die den Bestand als Datei speichert, und importiere diese Datei über die REST-Schnittstelle. Ein Export aus Lager: `export_data {instance, prefix?, limit?}` oder `GET /api/instances/<slug>/export` (NDJSON, auch als Link „Daten exportieren (NDJSON)“ auf der Instanzseite).
7. **Prüfen.** Öffne die Instanz, lies mit `db_read` oder `export_data` stichprobenartig nach und bitte den Nutzer, die wichtigsten Abläufe auszuprobieren.

Grenzen: Private Bereiche anderer Nutzer (`data/users/<id>/…`) lassen sich weder importieren noch exportieren; geschrieben werden kann nur der eigene. Hochgeladene Dateien wandern nicht mit: lade sie über die App (`assets.upload`) erneut hoch und ersetze die Verweise. Ein Import ersetzt Dokumente mit gleichem Pfad, löscht aber keine anderen. Vor einem Import legt Lager keinen Schnappschuss an; sichere vorhandene Daten bei Bedarf vorher mit `export_data`.

