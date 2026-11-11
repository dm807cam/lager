# Lager – Stufe 2 (Konten und Rechte): Design

Stufe 1 kennt ein einziges Admin-Konto. Stufe 2 macht Lager zur Mehrnutzer-Plattform: Menschen registrieren sich, der Administrator vergibt Rollen, Besitzer geben Instanzen gezielt frei, und andere Nutzer bekommen eigene Instanzen derselben App mit eigenen Daten.

## Vom Auftraggeber festgelegt

- Registrierung „wie auf GitHub": selbst, mit E-Mail und Passwort.
- Wer Zugriff hat, kann Apps nutzen und – wenn der Administrator es erlaubt – selbst bereitstellen.
- Ein Administrator verwaltet Nutzer und Rechte in einer Oberfläche.
- Zwei Arten des Teilens: **dieselbe Instanz teilen** (gemeinsame Daten) und **neue Instanz derselben App** (eigene Daten).
- Daten bleiben bei jedem Codewechsel erhalten (gilt unverändert).

## Entscheidungen des Entwurfs (nicht vom Auftraggeber vorgegeben)

Alles Folgende ist Vorschlag des Entwurfs und kann geändert werden.

### Konten
- Registrierungsmodus als Plattform-Einstellung: `open` (jeder), `invite` (nur mit Einladungslink), `closed`. Standard: `open`, wenn Mailversand konfiguriert ist, sonst `invite`.
- Registrierung: Name, E-Mail, Passwort (mindestens 10 Zeichen). Bei konfiguriertem Mailversand muss die E-Mail über einen Link bestätigt werden (24 h gültig), vorher ist keine Anmeldung möglich. Ohne Mailversand gelten Konten aus Einladungen sofort als bestätigt.
- Einladungen: der Administrator erzeugt einen Link (7 Tage, einmalig, optional an eine E-Mail gebunden, mit Zielrolle). Der Link wird angezeigt und, wenn möglich, per Mail verschickt.
- Passwort vergessen: Link per Mail (1 h, einmalig). Die Antwort verrät nicht, ob die Adresse existiert. Ohne Mailversand kann der Administrator einen Rücksetz-Link für ein Konto erzeugen und weitergeben.
- Konto-Seite: Name ändern, Passwort ändern (altes Passwort nötig).
- „Abmelden" beendet alle Sitzungen des Kontos, auch die auf Instanzen. Passwortänderung und Deaktivierung ebenso.
- Mailversand über SMTP (`LAGER_SMTP_URL`, `LAGER_MAIL_FROM`). Mails sind deutsch und reiner Text.
- Begrenzungen gegen Missbrauch: Registrierung und „Passwort vergessen" je IP und je E-Mail begrenzt.

### Rollen auf Plattform-Ebene
| Rolle | Darf |
|---|---|
| `admin` | Nutzer, Einladungen, Gruppen, Einstellungen verwalten; alle Apps/Instanzen als Liste sehen und deaktivieren |
| `publisher` | Apps deployen, Instanzen anlegen und freigeben |
| `user` | freigegebene Instanzen nutzen, eigene Instanzen freigegebener Apps anlegen |

- Neue Registrierungen sind `user`. Einladungen können eine andere Rolle vorgeben.
- Der Administrator kann Rollen ändern und Konten deaktivieren (kein Löschen in dieser Stufe). Der letzte aktive Administrator kann weder herabgestuft noch deaktiviert werden.
- Administratoren haben weiterhin keinen Zugriff auf Inhalte fremder Instanzen. Sie sehen Metadaten (Besitzer, Größe, aktive Version) und können eine Instanz deaktivieren; eine deaktivierte Instanz liefert allen außer dem Hinweis „deaktiviert" nichts aus.

### Rechte an einer Instanz
- Stufen wie in Stufe 1: `view < interact < admin < owner`. Deutsche Bezeichnungen: Betrachter, Mitwirkender, Verwalter, Besitzer.
- Freigaben (`grants`) an einzelne Nutzer oder Gruppen mit Stufe `view`, `interact` oder `admin`.
- Sichtbarkeit bleibt: `private` (nur Besitzer und Freigaben), `users` (alle Angemeldeten, Stufe wählbar `view`/`interact`, Standard `interact`), `public` (alle, auch anonym, Stufe `view`).
- Wirksame Stufe = höchste aus Besitz, direkter Freigabe, Gruppen-Freigaben und Sichtbarkeit.
- `admin` an einer Instanz darf: Version aktivieren, Sichtbarkeit ändern, Freigaben verwalten, Schnappschüsse wiederherstellen. Nur der Besitzer darf die Instanz löschen. Stufe `owner` kann nicht vergeben werden.
- Gruppen legt der Administrator an und pflegt ihre Mitglieder.

### Rechte an einer App
- Besitzer und **Mitarbeiter** (vom Besitzer benannte Nutzer mit Rolle `publisher` oder `admin`) dürfen neue Versionen deployen und Instanzen anlegen.
- Eigene Instanzen für andere: Besitzer/Mitarbeiter können eine Instanz für einen anderen Nutzer anlegen (dieser wird Besitzer der Instanz).
- Selbstbedienung: pro App einstellbar `selfInstances: off | users`. Bei `users` kann jeder Angemeldete im Katalog „Eigene Instanz anlegen" und wird deren Besitzer. Standard `off`.
- Der Besitzer einer Instanz, der nicht App-Besitzer ist, verwaltet seine Instanz selbst (Freigaben, Sichtbarkeit, Version), kann aber nicht deployen.

### Löschen
- Instanz löschen (Besitzer): Die Instanz verschwindet, ihr Datenverzeichnis wird nach `<dataDir>/trash/<instanceId>-<zeit>` verschoben, nicht gelöscht.
- App löschen (Besitzer): nur möglich, wenn keine Instanz der App einem anderen Nutzer gehört; eigene Instanzen wandern in den Papierkorb.

### Grenzen
- Datenmenge pro Instanz begrenzt (`LAGER_INSTANCE_QUOTA_MB`, Standard 50). Schreibzugriffe über der Grenze schlagen mit `quota_exceeded` fehl.
- Höchstzahl Instanzen pro Nutzer als Einstellung (Standard 20), Administratoren ausgenommen.

### Oberfläche
- Startseite für alle Angemeldeten: „Meine Instanzen", „Für mich freigegeben", „Katalog" (Instanzen mit Sichtbarkeit `users`/`public` und Apps mit Selbstbedienung); für Publisher zusätzlich „Meine Apps" wie bisher.
- Instanz-Seite: Versionen, Schnappschüsse, Sichtbarkeit, Freigaben (Nutzer per E-Mail oder Gruppe hinzufügen, Stufe ändern, entfernen), Löschen.
- App-Seite: Mitarbeiter, Selbstbedienung, Instanz für anderen Nutzer anlegen, Löschen.
- Admin-Bereich: Nutzer (Rolle, deaktivieren, Rücksetz-Link), Einladungen, Gruppen, Einstellungen (Registrierungsmodus, Instanz-Limit), Übersicht aller Apps/Instanzen mit „Deaktivieren".
- Öffentliche Seiten: Registrieren, E-Mail bestätigen, Passwort vergessen/zurücksetzen.

### Laufzeit und Claude-Anbindung
- `claude.use("user")`: `search(q)` liefert Nutzer mit Zugriff auf die Instanz (nur bei deklariertem Scope `profile`); `profiles` unverändert.
- Neue MCP-Werkzeuge: `share_instance`, `unshare_instance`, `list_shares`; `create_instance` erhält `owner_email`. REST spiegelt die Freigaben unter `/api/instances/:slug/grants`.
- Bauanleitung und Skill beschreiben das Teilen und die zwei Arten von Instanzen.

## Nicht enthalten
Uploads, Echtzeit-Räume, eigene Domains pro Instanz, Import bestehender Artefakte (Stufe 3); Konto-Löschung, Zwei-Faktor-Anmeldung, externe Anmeldedienste.

## Technik
- Neue Abhängigkeit: `nodemailer` (SMTP). Sonst unverändert wie Stufe 1.
- Sitzungen bleiben signierte Tokens; sie tragen zusätzlich die Sitzungs-Epoche des Kontos, die bei Abmelden, Passwortänderung und Deaktivierung erhöht wird.
- Alle neuen Tabellen in der Plattform-Datenbank über Migration 3.
