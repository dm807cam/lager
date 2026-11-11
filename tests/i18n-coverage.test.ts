import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { en } from '../src/i18n/en.js';
import { LOCALES, t, type Locale, type MessageKey } from '../src/i18n/index.js';
import { makeHarness, type Harness } from './support/http.js';

const SRC = path.resolve(import.meta.dirname, '../src');

function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(SRC, 'i18n') ? [] : sourceFiles(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * The contents of every string and template literal of a source file (comments, identifiers and regular expressions are
 * skipped, so a German word in a comment or an identifier never counts, while one inside a literal always does).
 */
function literals(source: string): string[] {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  const readString = (quote: string): void => {
    let s = '';
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') { s += source[i + 1] ?? ''; i += 2; continue; }
      s += source[i++];
    }
    i++;
    out.push(s);
  };
  const readTemplate = (): void => {
    let s = '';
    i++;
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') { s += source[i + 1] ?? ''; i += 2; continue; }
      if (source[i] === '$' && source[i + 1] === '{') { out.push(s); s = ''; i += 2; code(true); continue; }
      s += source[i++];
    }
    i++;
    out.push(s);
  };
  /** Scans code; inside a template substitution it returns at the closing brace. */
  function code(inSubstitution: boolean): void {
    let depth = 0;
    let last = ''; // last significant character, to tell a regular expression from a division
    while (i < n) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
      if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
      if (c === "'" || c === '"') { readString(c); last = 'a'; continue; }
      if (c === '`') { readTemplate(); last = 'a'; continue; }
      if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
        i++;
        let inClass = false;
        while (i < n && (source[i] !== '/' || inClass)) {
          if (source[i] === '\\') i++;
          else if (source[i] === '[') inClass = true;
          else if (source[i] === ']') inClass = false;
          i++;
        }
        i++;
        last = 'a';
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (inSubstitution && depth === 0) { i++; return; } depth--; }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  code(false);
  return out;
}

const GERMAN_CHARS = /[äöüÄÖÜß„“]/;
const GERMAN_WORDS = [
  'Speichern', 'Löschen', 'Freigabe', 'Freigaben', 'Instanz', 'Instanzen', 'Einladung', 'Einladungen', 'Passwort', 'Anmelden', 'Abmelden',
  'Übersicht', 'Verwaltung', 'Nutzer', 'Gruppe', 'Gruppen', 'Zurück', 'Hinzufügen', 'Entfernen', 'Aktivieren', 'Deaktivieren', 'Besitzer',
  'Einstellungen', 'Konto', 'Widerrufen', 'Erstellt', 'Sichtbarkeit', 'Schnappschüsse', 'Mitarbeiter', 'Verwalter', 'Betrachter', 'Größe',
  'Datum', 'Öffnen', 'Fehler', 'gefunden', 'Wiederherstellen', 'Umbenennen', 'Benutzer', 'Zugriff', 'Bestätigung', 'gespeichert', 'selbst', 'Geschlossen', 'Offen', 'Einladung', 'Rolle', 'Rücksetz', 'Mitglieder', 'Registrierung',
];
const GERMAN_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${GERMAN_WORDS.join('|')})(?![\\p{L}\\p{N}_])`, 'u');

describe('catalog-only text', () => {
  it('the literal scanner reads literals and ignores comments, regular expressions and identifiers', () => {
    const found = literals("// Löschen\nconst Übersicht = 'a' + `b${'c'}d`; /* Speichern */ x.replace(/'/g, \"e\"); const r = a / b;");
    expect(found).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('no human-facing German remains outside the catalogs', () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      for (const text of literals(fs.readFileSync(file, 'utf8'))) {
        if (GERMAN_CHARS.test(text) || GERMAN_WORD_RE.test(text)) offences.push(`${path.relative(SRC, file)}: ${text.slice(0, 80)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('every catalog key is used somewhere in src', () => {
    const code = sourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const unused = (Object.keys(en) as MessageKey[]).filter((key) => !code.includes(`'${key}'`) && !code.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });

  it('every t() call uses an existing key', () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const code = fs.readFileSync(file, 'utf8');
      for (const m of code.matchAll(/\bt\(\s*[^,()]+,\s*'([^']+)'/g)) {
        if (!(m[1] in en)) missing.push(`${path.relative(SRC, file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every quoted string shaped like a message key is a catalog key', () => {
    const stray: string[] = [];
    const prefixes = new Set(Object.keys(en).map((k) => k.split('.')[0]));
    for (const file of sourceFiles()) {
      for (const text of literals(fs.readFileSync(file, 'utf8'))) {
        if (/^[a-z]+(\.[A-Za-z]+)+$/.test(text) && prefixes.has(text.split('.')[0]) && !(text in en)) stray.push(`${path.relative(SRC, file)}: ${text}`);
      }
    }
    expect(stray).toEqual([]);
  });
});

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

/** Strips the stylesheet, which legitimately contains braces. */
const bodyOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, '');

describe('signed-in pages in every locale', () => {
  const SENTINELS: Record<string, MessageKey[]> = {
    home: ['dash.ownInstances', 'dash.createOwn', 'dash.tokens.create', 'dash.latestVersion', 'dash.connect'],
    instance: ['instance.delete.title', 'instance.grants.title', 'instance.snapshots.title', 'instance.visibility.who', 'instance.autoUpdate.label'],
    app: ['app.collaborators', 'app.self.title', 'app.delete.title', 'app.newInstance', 'app.collaboratorEmail'],
    users: ['admin.section.settings', 'admin.users.resetLink', 'admin.users.role'],
    invites: ['admin.invites.create', 'admin.invites.validUntil'],
    groups: ['admin.groups.create', 'admin.groups.newName'],
    group: ['admin.groups.delete', 'admin.groups.memberEmail'],
    settings: ['admin.settings.maxInstances', 'admin.settings.registration'],
    adminApps: ['admin.apps.data', 'common.owner'],
  };
  const PAGES: Array<[string, string]> = [
    ['home', '/'], ['instance', '/instances/notes'], ['app', '/apps/notes'], ['users', '/admin/users'], ['invites', '/admin/invites'],
    ['groups', '/admin/groups'], ['group', '/admin/groups/GROUP'], ['settings', '/admin/settings'], ['adminApps', '/admin/apps'],
  ];

  async function seed(hh: Harness): Promise<string> {
    const { core } = hh;
    const other = core.users.create({ email: 'u@x.y', name: 'U', password: 'password-123', role: 'publisher' });
    core.apps.deploy({ slug: 'notes', html: '<p>1</p>', title: 'Notes', userId: hh.adminId });
    core.apps.deploy({ slug: 'empty-app', html: '<p>1</p>', title: 'Empty', userId: other.id });
    const inst = core.apps.getInstanceBySlug('notes')!;
    core.data.snapshot(inst.id, 'manual-one');
    const group = core.groups.create('Team');
    core.groups.addMember(group.id, other.id);
    core.access.setGrant(inst, 'user', other.id, 'view', core.users.get(hh.adminId)!);
    core.tokens.create(hh.adminId, 'laptop');
    core.settings.setCustomDomains('publishers');
    core.domains.add(inst, 'notes.example.com', core.users.get(hh.adminId)!, true);
    core.apps.setSelfInstances(core.apps.getApp('empty-app')!.id, 'users', other.id);
    core.apps.addCollaborator(core.apps.getApp('notes')!.id, other.id, hh.adminId);
    await core.accounts.createInvite({ role: 'user', createdBy: hh.adminId, locale: 'en' });
    return group.id;
  }

  it('render without missing-key output and translated in every locale', async () => {
    h = makeHarness({ extensions: [dashboardExtension, manageExtension, adminExtension] });
    const groupId = await seed(h);
    const cookie = await h.login();
    for (const locale of LOCALES) {
      for (const [name, route] of PAGES) {
        const res = await request(h.app).get(route.replace('GROUP', groupId)).set('Host', h.host).set('Cookie', `${cookie}; lager_lang=${locale}`);
        const where = `${locale} ${name}`;
        expect(res.status, where).toBe(200);
        expect(res.text, where).toContain(`<html lang="${locale}"`);
        const body = bodyOf(res.text);
        expect(body, where).not.toContain('{');
        expect(body, where).not.toContain('undefined');
        expect(body, where).not.toContain('[object');
        for (const key of SENTINELS[name]) {
          expect(body, `${where} ${key}`).toContain(esc(t(locale, key)));
          if (locale !== 'en' && t(locale as Locale, key) !== t('en', key)) expect(body, `${where} ${key} English`).not.toContain(esc(t('en', key)));
          if (locale !== 'en') expect(t(locale, key), `${where} ${key} translated`).not.toBe(t('en', key));
        }
      }
    }
  });

  it('the language switcher on every signed-in page returns to that page', async () => {
    h = makeHarness({ extensions: [dashboardExtension, manageExtension, adminExtension] });
    const groupId = await seed(h);
    const cookie = await h.login();
    for (const route of ['/', '/instances/notes', '/apps/notes', '/admin/invites', '/admin/settings', `/admin/groups/${groupId}`]) {
      const res = await request(h.app).get(route).set('Host', h.host).set('Cookie', cookie);
      expect(res.text, route).toContain(`href="/lang/de?return=${encodeURIComponent(route)}"`);
    }
  });
});
