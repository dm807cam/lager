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
Einzelheiten (Regeln, Grenzen, Versionen, Instanzen, Daten vorbefüllen): Werkzeug `get_guide`.

---

# Lager – Anleitung für Claude

## Capabilities

`window.claude.use(name)` liefert ein Promise auf einen Namensraum oder `null`:

- `db` – Dokumenten-Datenbank nach dem Vertrag der Claude-Artefakte: `db.collection("tasks")`, `db.doc("tasks/t1")`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot` (Live-Updates), `acquire` (Sperre mit Ablaufzeit).
- `user` – `id`, `name`, `email` (nur mit `user: {scopes: ["email"]}`), `isOwner`, `canEdit`, `can`, `me`, `profiles`, `search`, `avatarUrl`. `search` braucht `user: {scopes: ["profile"]}`. Jedes Mitglied von `user` ist eine asynchrone Funktion, auch `name`: `const name = await user.name();`.
- `permissions` – `state`, `request`, `manage`; alles gilt als gewährt.
- Alles andere (z. B. `assets`, `room`, `artifact`) liefert `null`. Baue das Artefakt so, dass es ohne diese Namensräume funktioniert: prüfe auf `null` und blende die Funktion aus.

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

- Pfad: höchstens 16 Segmente und 1000 Byte, jedes Segment höchstens 200 Byte, keine leeren Segmente.
- Dokumentpfade haben eine gerade Zahl von Segmenten (`tasks/t1`), Sammlungspfade eine ungerade (`tasks`).
- Dokument: höchstens 256 KiB als JSON und 32 Ebenen tief; Zahlen müssen endlich sein.
- Abfragen: höchstens 1000 Treffer.
- HTML: höchstens 16 MiB.

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

Höchstens 100 Operationen pro Aufruf (`set` ersetzt, `update` führt zusammen, `delete` löscht). `db_read {instance, path, where?, orderBy?, limit?}` liest ein Dokument (`{doc}`) oder eine Sammlung (`{docs}`). Beide handeln mit deiner eigenen Stufe auf der Instanz: der Besitzer ohne die Regeln der App, ein Verwalter nach den Regeln der App (Regeln, die `owner` verlangen, bleiben ihm verschlossen). Private Bereiche anderer Nutzer bleiben immer gesperrt.

## Kompatibilität mit `window.storage`

Artefakte aus dem claude.ai-Chat, die `window.storage.get/set/delete/list(key | prefix, shared)` benutzen, laufen weiter: Mit `shared = true` landen die Werte in der Sammlung `kv` (für alle Betrachter der Instanz), sonst unter `data/users/<id>/storage/kv/<key>` (nur für den Betrachter); geteilte Werte liegen unter `kv/<key>`. Werte sind Zeichenketten. Ein gelöschtes Dokument nimmt seine Unter-Sammlungen nicht mit: `delete` entfernt nur das Dokument selbst. Für neue Artefakte ist `claude.use("db")` die bessere Wahl.
