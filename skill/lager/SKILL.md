---
name: lager
description: Nutze diesen Skill, wenn der Nutzer ein Artefakt, eine kleine App oder ein Werkzeug gebaut haben möchte und ein Lager-Connector verfügbar ist. Das Ergebnis wird auf dem eigenen Lager-Server mit dauerhaftem Datenspeicher veröffentlicht statt als claude.ai-Artefakt.
---

Lager ist ein selbst gehosteter Server für Claude-Artefakte: Jede App bekommt eine eigene Subdomain, nummerierte Versionen mit Zurückrollen und einen dauerhaften Datenspeicher pro Instanz.
Baue das Artefakt genau wie ein Claude-Artefakt: eine einzige HTML-Datei, Skripte und Styles inline oder von einem CDN.
Dauerhafte Daten nur über `const db = await claude.use("db")` – niemals `localStorage`, `sessionStorage` oder `indexedDB`, die gehen beim Gerätewechsel verloren.
Angaben zum Nutzer liefert `await claude.use("user")`.
Gib beim Deploy die `capabilities` an, die das Artefakt nutzt, meist `{"db": {}, "user": {}}`.
Deploye mit dem Werkzeug `deploy_app` (slug, html, title, capabilities, note), statt ein claude.ai-Artefakt zu veröffentlichen.
Hast du eine Shell und ein `LAGER_TOKEN`, lade die Datei direkt hoch, statt ihren Inhalt als Argument zu senden:
`curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" --data-binary @index.html "<Lager-Adresse>/api/apps/<slug>?title=...&capabilities=..."`
Nenne dem Nutzer danach die zurückgegebene URL und jede Warnung aus `warnings`.
Einzelheiten (Regeln, Grenzen, Versionen, Instanzen, Daten vorbefüllen): Werkzeug `get_guide`.

---

# Lager – Anleitung für Claude

## Capabilities

`window.claude.use(name)` liefert ein Promise auf einen Namensraum oder `null`:

- `db` – Dokumenten-Datenbank nach dem Vertrag der Claude-Artefakte: `db.collection("tasks")`, `db.doc("tasks/t1")`, `get/set/update/delete/add`, `where/orderBy/limit`, `onSnapshot` (Live-Updates), `acquire` (Sperre mit Ablaufzeit).
- `user` – `id`, `name`, `email` (nur mit `user: {scopes: ["email"]}`), `isOwner`, `canEdit`, `can`, `me`, `profiles`, `search`, `avatarUrl`.
- `permissions` – `state`, `request`, `manage`; alles gilt als gewährt.
- Alles andere (z. B. `assets`, `room`, `artifact`) liefert `null`. Baue das Artefakt so, dass es ohne diese Namensräume funktioniert: prüfe auf `null` und blende die Funktion aus.

`window.claude.complete` gibt es nicht; der Aufruf lehnt mit einer Fehlermeldung ab.

## Zugriffsregeln der Datenbank

Stufen: `view < interact < admin < owner`, dazu `self` (hält niemand für sich allein). Wer was erreicht: Besitzer der Instanz → `owner`; bei Sichtbarkeit `users` jeder Angemeldete → `interact`; bei `public` auch Anonyme → `view`.

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

## Instanzen

Der erste Deploy legt die Standard-Instanz mit dem Slug der App an (Sichtbarkeit `private`). `create_instance {app, slug, visibility?}` legt eine weitere Instanz mit eigener Subdomain und getrennten Daten an. `set_visibility {instance, visibility}` setzt `private` (nur Besitzer), `users` (alle Angemeldeten) oder `public` (ohne Anmeldung). Instanz-Slugs sind global eindeutig.

## Daten vorbefüllen

Schreibe Start- und Beispieldaten nicht fest ins HTML, sondern lege sie nach dem Deploy mit `db_write` an:

```json
{"instance": "todo", "ops": [
  {"op": "set", "path": "tasks/t1", "data": {"title": "Erste Aufgabe", "done": false}},
  {"op": "update", "path": "settings/main", "data": {"theme": "hell"}}
]}
```

Höchstens 100 Operationen pro Aufruf (`set` ersetzt, `update` führt zusammen, `delete` löscht). `db_read {instance, path, where?, orderBy?, limit?}` liest ein Dokument (`{doc}`) oder eine Sammlung (`{docs}`). Beide handeln als Besitzer ohne die Regeln der App, private Bereiche anderer Nutzer bleiben aber gesperrt.

## Kompatibilität mit `window.storage`

Artefakte aus dem claude.ai-Chat, die `window.storage.get/set/delete/list(key | prefix, shared)` benutzen, laufen weiter: Mit `shared = true` landen die Werte in der Sammlung `kv` (für alle Betrachter der Instanz), sonst unter `data/users/<id>/kv` (nur für den Betrachter). Werte sind Zeichenketten. Für neue Artefakte ist `claude.use("db")` die bessere Wahl.
