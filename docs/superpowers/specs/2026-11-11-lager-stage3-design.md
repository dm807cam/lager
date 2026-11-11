# Lager – Stufe 3 (Ausbau): Design

Stufe 3 schließt die Lücke zwischen dem, was Claudes Artefakte können, und dem, was Lager bisher nachbildet, und macht Apps unter eigenen Domains erreichbar. Außerdem sorgt sie dafür, dass man Code und Daten jederzeit wieder herausbekommt und bestehende Artefakte übernehmen kann.

## Vom Auftraggeber festgelegt (aus der Stufenplanung)

Uploads, Echtzeit, eigene Domains pro App, Schnappschüsse und Export, Übernahme bestehender Artefakte. Leitgedanken unverändert: Artefakte laufen so, wie Claude sie baut; Daten bleiben erhalten; der Betreiber besitzt Code und Daten.

## Entscheidungen des Entwurfs (nicht vom Auftraggeber vorgegeben)

### Neue Laufzeit-Bausteine
`claude.use(name)` liefert zusätzlich:

- **`assets`** – Datei-Uploads nach dem Vertrag der Claude-Artefakte: `upload(blob)`, `list()`, `delete(id)`. Dateien liegen im Verzeichnis der Instanz und werden unter `/_blob/<id>` auf dem Host der Instanz ausgeliefert.
  - Erlaubte Typen: Bilder, SVG, Video, Audio, PDF, Schriften, CSS/JS, CSV/Markdown/JSON/Text. HTML wird abgelehnt.
  - Größen: 20 MiB je Datei, CSS/JS 16 MiB, SVG 2 MiB. Uploads zählen auf die Datengrenze der Instanz.
  - Rechte: Standard nur Stufe `admin`/`owner`. Deklariert die App `{assets:{upload:"interact"}}`, dürfen auch Mitwirkende hochladen, sehen und löschen aber nur eigene Dateien.
  - Sicherheit: alle Antworten mit `X-Content-Type-Options: nosniff`; SVG und Textformate zusätzlich mit einer Sandbox-Richtlinie, sodass darin enthaltene Skripte beim direkten Öffnen nicht laufen.
  - Schnappschüsse umfassen weiterhin nur Dokumente, keine Dateien.
- **`room`** – Echtzeit zwischen allen, die die Seite gerade offen haben: `emit`/`on` (Ereignisse), `presence`/`onPeers` (Anwesenheit), `join(name)` für Unterräume. Nichts wird gespeichert. Transport: Server-Sent Events plus POST (keine neue Abhängigkeit). Ereignis-Themen dürfen standardmäßig nur `admin`/`owner` senden; die App kann einzelne Themen für `interact` öffnen (`{room:{topics:{<thema>:"interact"}}}`). Anwesenheit darf jeder setzen, der die Seite öffnen darf.
- **`artifact`** (und der alte Name `self`) – die Seite speichert sich selbst als neue Version: `publish(html)`.
  - Nur Stufe `admin`/`owner`, und nur wenn die App `artifact` deklariert.
  - Die neue Version gehört zu genau dieser Instanz, wird nur dort aktiviert und schaltet die automatische Aktualisierung der Instanz ab, damit ein späteres Deploy den selbst gespeicherten Stand nicht überschreibt. Der Besitzer kann sie auf der Instanz-Seite wieder einschalten.
  - Selbst gespeicherte Versionen sind für andere Instanzen nicht aktivierbar und zählen nicht als „neueste Version" der App.
  - Gleichzeitiges Speichern: wer auf einem veralteten Stand speichert, bekommt `conflict`. Alle offenen Ansichten laden nach einem erfolgreichen Speichern neu.
  - Höchstens 60 Speichervorgänge pro Stunde und Instanz.
- **`downloads`** – `save({filename, data})` bietet dem Betrachter nach Rückfrage eine Datei zum Speichern an (rein im Browser).

Weiterhin nicht nachgebildet (liefern `null`): `sample`, `mcp`, `tts`, `dictation`, `files`, `comments`. `sample` bräuchte einen API-Schlüssel des Betreibers und eine Kostenentscheidung; das bleibt ausdrücklich offen.

### Eigene Domains
- Eine Instanz kann zusätzlich zu `<slug>.<apps-domain>` unter beliebig vielen eigenen Hostnamen erreichbar sein.
- Wer darf das: Plattform-Einstellung `customDomains: admins | publishers`, Standard `admins`. Bei `publishers` dürfen Publisher mit Verwaltungsrecht an der Instanz Domains setzen.
- Regeln: gültiger Hostname in Kleinbuchstaben, keine IP-Adresse, nicht der Plattform-Host, nicht unterhalb der Apps-Domain, plattformweit eindeutig.
- Anmeldung funktioniert wie bisher über den Umleitungs-Handshake; der Code gilt weiter nur für die Instanz. Das Sitzungs-Cookie ist an den jeweiligen Host gebunden.
- DNS, Proxy-Eintrag und Zertifikat für die Domain richtet der Betreiber ein; Lager prüft den Besitz der Domain nicht.
- Verwaltung auf der Instanz-Seite, über REST und MCP.

### Export und Import
- **Daten exportieren:** Verwalter einer Instanz laden alle Dokumente als NDJSON herunter (eine Zeile je Dokument: Pfad und Daten). Private Bereiche anderer Nutzer (`data/users/<id>/…`) sind nicht enthalten.
- **Daten importieren:** NDJSON oder JSON-Liste über REST, bis 1000 Dokumente pro Aufruf über MCP. Datengrenze und Pfadregeln gelten; private Bereiche anderer Nutzer sind gesperrt.
- **Code herausholen:** Das HTML jeder Version ist über REST und per Link im Dashboard abrufbar (für Besitzer und Mitarbeiter der App; selbst gespeicherte Versionen für Verwalter der jeweiligen Instanz).

### Übernahme bestehender Artefakte
- **Prüfung:** Beim Deploy und über ein eigenes Werkzeug meldet Lager, welche Bausteine ein Artefakt benutzt und welche davon Lager nicht nachbildet, zusätzlich zu den bestehenden Warnungen vor Browser-Speicher.
- **Anleitung für Claude:** Die Bauanleitung bekommt einen Abschnitt „Bestehende Artefakte übernehmen": Artefakt lesen, prüfen, nicht unterstützte Teile ersetzen, deployen, Daten aus der bisherigen Umgebung lesen und importieren.
- Daten, die bisher nur im Browser eines Nutzers liegen (Browser-Speicher), kann Lager nicht von außen holen; die Anleitung beschreibt den Weg über einen einmaligen Export im alten Artefakt.

## Nicht enthalten
`sample` und die übrigen oben genannten Bausteine; Besitzprüfung für Domains; Pfad-basierte Adressen unterhalb der Plattform-Domain; automatischer Import ganzer Konten von claude.ai.

## Technik
Keine neuen Abhängigkeiten. Neue Plattform-Tabellen über Migrationen 5 (Zuordnung selbst gespeicherter Versionen zu Instanzen) und 6 (Domains). Datei-Metadaten liegen in einer eigenen SQLite-Datei je Instanz neben den Dateien.

## Nachtrag: Englisch als Standard und Mehrsprachigkeit (Entscheidung des Auftraggebers)

- Das gesamte Produkt ist standardmäßig englisch. Mehrsprachigkeit ist eingebaut; ausgeliefert werden Englisch, Französisch, Spanisch und Deutsch. Weitere Sprachen lassen sich durch eine zusätzliche Katalog-Datei ergänzen.
- Sprache einer Sitzung: Einstellung im Konto, sonst die im Sprachumschalter gewählte, sonst die des Browsers, sonst `LAGER_DEFAULT_LOCALE` (Standard `en`).
- Übersetzt werden alle Seiten, Hinweise, E-Mails und Dialoge für Menschen. Nicht übersetzt (immer englisch) wird alles, was Maschinen oder Claude lesen: Fehlermeldungen der Schnittstellen, MCP-Werkzeuge, Artefakt-Prüfung, Bauanleitung, Skill, README.
- Marken-Text (Wortlaut des Auftraggebers): „The only two apps you'll ever need: Claude + Lager." mit dem Erklärsatz darunter, auf der Anmeldeseite und in der README.
