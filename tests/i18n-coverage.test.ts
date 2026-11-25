import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { badCodePage, disabledPage, esc, forbiddenPage, noticeHtml, notFoundPage } from '../src/http/pages.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { es } from '../src/i18n/es.js';
import { fr } from '../src/i18n/fr.js';
import { LOCALES, t, type Locale, type MessageKey } from '../src/i18n/index.js';
import { MemoryMailer } from '../src/platform/mail.js';
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
 * skipped, so a German word in a comment or an identifier never counts, while one inside a literal always does). `at` is the offset
 * of the opening quote, or, for the text after a `${…}` substitution, of the character after its closing brace.
 */
function literalsAt(source: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  const n = source.length;
  let i = 0;
  const readString = (quote: string): void => {
    let s = '';
    const at = i;
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') { s += source[i + 1] ?? ''; i += 2; continue; }
      s += source[i++];
    }
    i++;
    out.push({ text: s, at });
  };
  const readTemplate = (): void => {
    let s = '';
    let at = i;
    i++;
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') { s += source[i + 1] ?? ''; i += 2; continue; }
      if (source[i] === '$' && source[i + 1] === '{') { out.push({ text: s, at }); s = ''; i += 2; code(true); at = i; continue; }
      s += source[i++];
    }
    i++;
    out.push({ text: s, at });
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

const literals = (source: string): string[] => literalsAt(source).map((l) => l.text);

/**
 * Inline human-facing text in a page handler, in any language. Two shapes are recognised inside string and template literals:
 *  - an HTML text node: a `>` followed by a word of two or more letters (`<p>Nothing here</p>`, `<td>Aucun</td>`); the product
 *    names in TEXT_ALLOWED, a single letter (the "v" of "v3") and arrow functions or `->` are fine;
 *  - a sentence: a capital letter (or ¿ ¡) first and a space somewhere in the literal ("Delete this group?").
 * Plus attribute text (`title="Delete"`, `alt=`, `placeholder=`, `aria-label=`) that is not a substitution.
 * Machine-facing literals are allowed by shape: the message of a `LagerError` or another `…Error`, a `message:` or
 * `error_description:` property of a JSON body, the label a request validator puts into its message (`check(value, "Line 3")`),
 * the plain-text line of a non-browser 404, and SQL (what `.prepare()` / `.exec()` receive). A new machine-facing context
 * is added to MACHINE_CONTEXT on purpose; a sentence anywhere else is a missing catalog entry. A sentence that starts in
 * lowercase and contains no tag is not caught: the heuristic is a net, and the render tests below are the other half.
 */
const TEXT_ALLOWED = new Set(['Lager', 'Claude']);
const MACHINE_CONTEXT = /(?:new\s+\w*Error\(\s*(?:'[^']*',\s*)?|\bmessage:\s*|\berror_description:\s*|\.(?:prepare|exec)\(\s*|\.type\('text\/plain'\)\.send\(\s*|\bcheck\(\s*\w+,\s*)$/;
const SQL = /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|WITH)\b/;
const SENTENCE = /^[\p{Lu}¿¡][^\n]* /u;
const ATTRIBUTE_TEXT = /\b(?:title|alt|placeholder|aria-label)="\p{L}{2,}(?![\p{L}\p{N}._/:-])/u;

function inlineText(source: string): string[] {
  const found: string[] = [];
  for (const { text, at } of literalsAt(source)) {
    const words = [...text.matchAll(/(?<![=-])>\s*(\p{L}+)/gu)].map((m) => m[1]).filter((w) => w.length >= 2 && !TEXT_ALLOWED.has(w));
    const machine = MACHINE_CONTEXT.test(source.slice(Math.max(0, at - 80), at)) || SQL.test(text);
    if (words.length > 0 || ATTRIBUTE_TEXT.test(text) || (SENTENCE.test(text) && !machine)) found.push(text.slice(0, 80));
  }
  return found;
}

/** The files whose literals may carry no human-facing text: every page handler and the OAuth server. */
const PAGE_FILES = (): string[] => [
  ...fs.readdirSync(path.join(SRC, 'http')).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC, 'http', f)),
  path.join(SRC, 'mcp/oauth.ts'),
];

const GERMAN_CHARS = /[äöüÄÖÜß„“]/;
const GERMAN_WORDS = [
  'Speichern', 'Löschen', 'Freigabe', 'Freigaben', 'Instanz', 'Instanzen', 'Einladung', 'Einladungen', 'Passwort', 'Anmelden', 'Abmelden',
  'Übersicht', 'Verwaltung', 'Nutzer', 'Gruppe', 'Gruppen', 'Zurück', 'Hinzufügen', 'Entfernen', 'Aktivieren', 'Deaktivieren', 'Besitzer',
  'Einstellungen', 'Konto', 'Widerrufen', 'Erstellt', 'Sichtbarkeit', 'Schnappschüsse', 'Mitarbeiter', 'Verwalter', 'Betrachter', 'Größe',
  'Datum', 'Öffnen', 'Fehler', 'gefunden', 'Wiederherstellen', 'Umbenennen', 'Benutzer', 'Zugriff', 'Bestätigung', 'gespeichert', 'selbst', 'Geschlossen', 'Offen', 'Einladung', 'Rolle', 'Rücksetz', 'Mitglieder', 'Registrierung',
  'Verbindungen', 'offene', 'Offene', 'zu viele', 'nicht', 'Nicht', 'wurde', 'Wurde', 'bitte', 'Bitte',
];
/** The German example password of `.env.example` is refused at start-up (ADMIN_PASSWORD_PLACEHOLDERS), so it must stay a literal. */
const GERMAN_EXEMPT = new Set(['bitte-aendern']);
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
        if (!GERMAN_EXEMPT.has(text) && (GERMAN_CHARS.test(text) || GERMAN_WORD_RE.test(text))) offences.push(`${path.relative(SRC, file)}: ${text.slice(0, 80)}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('the inline-text scanner recognises text in any language and lets machine-facing literals through', () => {
    const bad = [
      "const a = `<p>Nothing here yet</p>`;",
      'const a = `<td>${x}</td><td>Aucun résultat</td>`;',
      "const a = '<button>Guardar</button>';",
      'const a = `<p class="x">${y}</p><p>Keine Daten</p>`;',
      "const a = 'Delete this group?';",
      "res.send('Something went wrong, try again');",
      "throw new Problem('Zugriff verweigert.');",
      "const a = '¿Seguro que quieres borrarlo?';",
      "const a = `<img src=\"${u}\" alt=\"Logo\">`;",
    ];
    for (const code of bad) expect(inlineText(code), code).not.toEqual([]);
    const good = [
      "throw new LagerError('not_found', 'Instance not found.');",
      "throw new LagerError('invalid_argument', `Line ${n} is not valid JSON.`);",
      "res.status(400).json({ error: { code: 'x', message: 'Request body too large.' } });",
      "res.json({ error: 'invalid_client', error_description: 'Invalid client credentials.' });",
      "this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = \\'access\\'');",
      "const a = `<td>v${n}</td><span class=\"name\">Lager</span><a href=\"/x\">${esc(t(l, 'k'))}</a>`;",
      "const f = (x) => x > 1 ? `a` : 'b'; const g = a => a;",
      "res.set('Cache-Control', 'no-store'); const h = 'text/html; charset=utf-8';",
      "const a = `<img src=\"/i.webp\" alt=\"\">`;",
    ];
    for (const code of good) expect(inlineText(code), code).toEqual([]);
  });

  it('no page handler or the OAuth server carries inline human-facing text', () => {
    const offences: string[] = [];
    for (const file of PAGE_FILES()) {
      for (const text of inlineText(fs.readFileSync(file, 'utf8'))) offences.push(`${path.relative(SRC, file)}: ${text}`);
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

/** Strips the pre-paint theme script, which legitimately contains braces. */
const bodyOf = (html: string): string => html.replace(/<script id="theme-init"[^>]*>[\s\S]*?<\/script>/, '');

describe('signed-in pages in every locale', () => {
  const SENTINELS: Record<string, MessageKey[]> = {
    home: ['dash.ownInstances', 'dash.createOwn', 'home.title', 'nav.main', 'nav.skip', 'theme.label', 'nav.publish', 'dash.getOwn'],
    publish: ['dash.tokens.create', 'dash.latestVersion', 'dash.connect', 'publish.lede', 'common.copy', 'common.copied', 'nav.publish'],
    instance: ['instance.delete.title', 'instance.grants.title', 'instance.snapshots.title', 'instance.visibility.who', 'instance.autoUpdate.label', 'common.dangerZone', 'instance.storage', 'instance.autoUpdate.title'],
    app: ['app.collaborators', 'app.self.title', 'app.delete.title', 'app.newInstance', 'app.collaboratorEmail'],
    users: ['admin.section.settings', 'admin.users.role', 'admin.users.aiGroup', 'common.manage'],
    user: ['admin.users.resetLink', 'admin.users.role', 'admin.users.role.hint', 'admin.users.aiGroup.hint', 'admin.users.signIn', 'admin.users.access', 'admin.users.deactivate.hint', 'admin.users.delete.active'],
    invites: ['admin.invites.create', 'admin.invites.validUntil'],
    groups: ['admin.groups.create', 'admin.groups.newName'],
    group: ['admin.groups.delete', 'admin.groups.memberEmail'],
    settings: ['admin.settings.maxInstances', 'admin.settings.registration', 'admin.settings.registration.hint', 'admin.settings.customDomains.hint', 'admin.sections'],
    adminApps: ['admin.apps.data', 'common.owner'],
    account: ['account.password.title', 'account.locale.label', 'nav.signOut'],
  };
  const PAGES: Array<[string, string]> = [
    ['home', '/'], ['publish', '/publish'], ['instance', '/instances/notes'], ['app', '/apps/notes'], ['users', '/admin/users'], ['user', '/admin/users/USER'], ['invites', '/admin/invites'],
    ['groups', '/admin/groups'], ['group', '/admin/groups/GROUP'], ['settings', '/admin/settings'], ['adminApps', '/admin/apps'], ['account', '/account'],
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
        const res = await request(h.app).get(route.replace('GROUP', groupId).replace('USER', h.core.users.getByEmail('u@x.y')!.id)).set('Host', h.host).set('Cookie', `${cookie}; lager_lang=${locale}`);
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

  it('the signed-out pages and an empty home render in every locale', async () => {
    h = makeHarness({ extensions: [dashboardExtension] });
    h.core.settings.setRegistration('open');
    const plain = h.core.users.create({ email: 'p@x.y', name: 'P', password: 'password-123', role: 'publisher' });
    const cookie = await h.login(plain.email, 'password-123');
    const pages: Array<[string, string, MessageKey[], string]> = [
      ['login', '/login', ['brand.tagline', 'brand.pitch', 'login.forgot', 'nav.skip'], ''],
      ['register', '/register', ['auth.register.title', 'common.toLogin'], ''],
      // This server sends no mail: the page says whom to ask instead of offering a form (the form itself is checked below).
      ['forgot', '/forgot', ['auth.forgot.title', 'auth.forgot.noMail', 'common.toLogin'], ''],
      ['empty home', '/', ['home.step.connect', 'home.step.ask', 'home.step.ask.text', 'home.step.appears', 'home.step.appears.text'], cookie],
    ];
    for (const locale of LOCALES) {
      for (const [name, route, keys, c] of pages) {
        const res = await request(h.app).get(route).set('Host', h.host).set('Cookie', `${c ? `${c}; ` : ''}lager_lang=${locale}`);
        const where = `${locale} ${name}`;
        expect(res.status, where).toBe(200);
        const body = bodyOf(res.text);
        expect(body, where).not.toContain('{');
        expect(body, where).not.toContain('undefined');
        for (const key of keys) {
          expect(body, `${where} ${key}`).toContain(esc(t(locale, key)));
          if (locale !== 'en') expect(t(locale, key), `${where} ${key} translated`).not.toBe(t('en', key));
        }
      }
    }
  });

  it('the forgot-password form of a server that sends mail renders in every locale', async () => {
    h = makeHarness({ extensions: [dashboardExtension], mailer: new MemoryMailer() });
    for (const locale of LOCALES) {
      const res = await request(h.app).get('/forgot').set('Host', h.host).set('Cookie', `lager_lang=${locale}`);
      const body = bodyOf(res.text);
      for (const key of ['auth.forgot.title', 'auth.forgot.submit', 'common.email'] as MessageKey[]) {
        expect(body, `${locale} ${key}`).toContain(esc(t(locale, key)));
      }
      expect(res.text, locale).toContain('action="/forgot"');
    }
  });

  it('the language switcher on every signed-in page returns to that page', async () => {
    h = makeHarness({ extensions: [dashboardExtension, manageExtension, adminExtension] });
    const groupId = await seed(h);
    const cookie = await h.login();
    for (const route of ['/', '/publish', '/instances/notes', '/apps/notes', '/admin/invites', '/admin/settings', `/admin/groups/${groupId}`]) {
      const res = await request(h.app).get(route).set('Host', h.host).set('Cookie', cookie);
      expect(res.text, route).toContain(`href="/lang/de?return=${encodeURIComponent(route)}"`);
    }
  });
});

/** Values that are the same word in the language as in English (loanwords, shared Latin vocabulary, product and role names). */
const SAME_AS_ENGLISH: Record<'de' | 'fr' | 'es', readonly string[]> = {
  de: ['common.name', 'nav.admin', 'nav.apps', 'nav.tab.apps', 'nav.tab.admin', 'theme.system', 'instance.details', 'common.version', 'common.status', 'role.admin', 'role.publisher', 'instance.version', 'instance.downloadHtml',
    'instance.domains.domain', 'instance.domains.host', 'app.pageTitle', 'admin.pageTitle', 'admin.section.apps', 'admin.apps.domains', 'instance.ingest.token', 'instance.ingest.origin', 'instance.embed.origin', 'admin.mail.port'],
  fr: ['nav.admin', 'nav.tab.apps', 'nav.tab.admin', 'common.actions', 'common.instance', 'common.version', 'common.date', 'role.publisher', 'instance.pageTitle', 'instance.version', 'dash.instanceCount.one', 'dash.instanceCount.other',
    'instance.downloadHtml', 'instance.grants.type', 'app.versions', 'app.instances', 'admin.section.invites', 'admin.ai.provider.ollama', 'admin.mail.port', 'confirm.groupDelete.instances.one', 'confirm.groupDelete.instances.other'],
  es: ['role.publisher', 'instance.downloadHtml', 'nav.tab.apps', 'nav.tab.admin', 'admin.ai.provider.ollama', 'instance.ingest.token'],
};

describe('translations', () => {
  it('every German, French and Spanish value differs from the English one unless the word is the same in that language', () => {
    const same: string[] = [];
    for (const [name, catalog] of [['de', de], ['fr', fr], ['es', es]] as const) {
      for (const key of Object.keys(en) as MessageKey[]) {
        if (catalog[key] === en[key] && !SAME_AS_ENGLISH[name].includes(key)) same.push(`${name} ${key}`);
      }
      for (const key of SAME_AS_ENGLISH[name]) expect(catalog[key as MessageKey], `${name} ${key} no longer needs its allowlist entry`).toBe(en[key as MessageKey]);
    }
    expect(same).toEqual([]);
  });

  it('French uses the typographic apostrophe only', () => {
    expect(Object.entries(fr).filter(([, v]) => v.includes("'")).map(([k]) => k)).toEqual([]);
  });
});

/** Sample values for the placeholders a notice text may carry. */
const PARAMS = { max: 63, min: 8, name: 'N', title: 'T', count: 2, user: 'U', slug: 's', section: 'S', number: 3, email: 'e@x.y' };

describe('error pages, notices and mail in every locale', () => {
  it('the error pages render the catalog text of each locale', () => {
    const pages: Array<[(l: Locale) => string, MessageKey, MessageKey]> = [
      [(l) => notFoundPage(l), 'error.notFound.title', 'error.notFound.text'],
      [(l) => forbiddenPage(l), 'error.forbidden.title', 'error.forbidden.text'],
      [(l) => disabledPage(l), 'error.disabled.title', 'error.disabled.text'],
      [(l) => badCodePage(l), 'error.badCode.title', 'error.badCode.text'],
    ];
    for (const locale of LOCALES) {
      for (const [render, title, text] of pages) {
        const html = render(locale);
        expect(html, `${locale} ${title}`).toContain(`<html lang="${locale}"`);
        for (const key of [title, text]) {
          expect(html, `${locale} ${key}`).toContain(esc(t(locale, key)));
          if (locale !== 'en') expect(html, `${locale} ${key} English`).not.toContain(esc(t('en', key)));
        }
      }
    }
  });

  it('the cross-origin refusal and the unknown-instance page answer in the language of the request', async () => {
    h = makeHarness();
    h.core.apps.deploy({ slug: 'wk', html: '<p>1</p>', userId: h.adminId });
    for (const locale of LOCALES) {
      const refused = await request(h.app).post('/login').set('Host', h.host).set('Origin', 'https://evil.example').set('Accept-Language', locale).type('form').send({ email: 'a@b.c', password: 'x' });
      expect(refused.status, locale).toBe(403);
      expect(refused.text, locale).toContain(esc(t(locale, 'error.crossOrigin')));
      expect(refused.text, locale).toContain(`<html lang="${locale}"`);
      const ghost = await request(h.app).get('/').set('Host', 'ghost.apps.localhost').set('Accept-Language', locale);
      expect(ghost.status, locale).toBe(404);
      expect(ghost.text, locale).toContain(esc(t(locale, 'error.notFound.text')));
    }
  });

  it('every notice key renders its text, with limits filled in, in every locale', () => {
    const keys = (Object.keys(en) as MessageKey[]).filter((k) => k.startsWith('notice.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const locale of LOCALES) {
      for (const key of keys) {
        const html = noticeHtml(locale, { error: key });
        const text = esc(t(locale, key, PARAMS));
        // A text that quotes a limit is rendered with the real number, never with a placeholder.
        expect(html, `${locale} ${key}`).not.toContain('{');
        if (!en[key].includes('{')) expect(html, `${locale} ${key}`).toContain(text);
        expect(noticeHtml(locale, { ok: key }), `${locale} ${key} ok`).toContain('role="status"');
        if (locale !== 'en' && !SAME_AS_ENGLISH[locale].includes(key)) expect(html, `${locale} ${key} English`).not.toContain(esc(t('en', key)));
      }
    }
  });

  it('every mail has its subject and body in the recipient language', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ mailer });
    h.core.settings.setRegistration('open');
    const english = new Map<string, { subject: string; text: string }>();
    for (const locale of LOCALES) {
      mailer.sent.length = 0;
      const email = `user-${locale}@x.y`;
      await h.core.accounts.register({ name: 'U', email, password: 'password-123', locale });
      await h.core.accounts.requestPasswordReset(email, locale);
      await h.core.accounts.createInvite({ email: `invited-${locale}@x.y`, role: 'user', createdBy: h.adminId, locale });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const kinds = ['verify', 'reset', 'invite'] as const;
      expect(mailer.sent, locale).toHaveLength(3);
      // The fourth mail: somebody registers with an address that already has an account.
      h.core.accounts.noticeExistingAccount(email, locale);
      const exists = mailer.sent[3];
      expect(exists.subject, locale).toBe(t(locale, 'mail.exists.subject'));
      for (const part of ['intro', 'reset', 'ignore'] as const) expect(exists.text, locale).toContain(t(locale, `mail.exists.${part}`));
      if (locale !== 'en') expect(exists.text, locale).not.toContain(t('en', 'mail.exists.intro'));
      for (const kind of kinds) {
        const mail = mailer.sent.find((m) => m.subject === t(locale, `mail.${kind}.subject`));
        expect(mail, `${locale} ${kind}`).toBeDefined();
        expect(mail!.text, `${locale} ${kind}`).toContain(t(locale, `mail.${kind}.intro`));
        expect(mail!.text, `${locale} ${kind}`).toContain(t(locale, `mail.validity.${kind}`));
        expect(mail!.text, `${locale} ${kind}`).not.toContain('{');
        if (locale === 'en') english.set(kind, { subject: mail!.subject, text: mail!.text });
        else {
          expect(mail!.subject, `${locale} ${kind}`).not.toBe(english.get(kind)!.subject);
          expect(mail!.text, `${locale} ${kind}`).not.toContain(t('en', `mail.${kind}.intro`));
        }
      }
    }
  });
});
