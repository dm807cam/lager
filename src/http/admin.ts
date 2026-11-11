import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { CustomDomainsMode, RegistrationMode } from '../platform/settings.js';
import type { Role, User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { esc, forbiddenAdminPage, optionList, page, signedInHeader } from './pages.js';
import { csrfToken, csrfValid } from './session.js';

const ROLE_LABELS: Array<[Role, string]> = [['admin', 'Administrator'], ['publisher', 'Publisher'], ['user', 'Nutzer']];
const DOMAIN_LABELS: Array<[CustomDomainsMode, string]> = [['admins', 'Nur Administratoren'], ['publishers', 'Auch Publisher']];
const MODE_LABELS: Array<[RegistrationMode, string]> = [['open', 'Offen'], ['invite', 'Nur mit Einladung'], ['closed', 'Geschlossen']];
const SECTIONS: Array<[string, string]> = [['users', 'Nutzer'], ['invites', 'Einladungen'], ['groups', 'Gruppen'], ['settings', 'Einstellungen'], ['apps', 'Apps']];
const LAST_ADMIN = 'Der letzte aktive Administrator kann nicht herabgestuft oder deaktiviert werden.';
const NO_ACCOUNT = 'Kein Konto mit dieser E-Mail-Adresse.';
const MAX_FIELD = 300;

type Section = 'users' | 'invites' | 'groups' | 'settings' | 'apps';
/** A note above the section; `once` carries a one-time link and is never stored. */
interface Msg { ok?: string; error?: string; once?: { title: string; link: string } }

const roleLabel = (role: Role): string => ROLE_LABELS.find(([r]) => r === role)?.[1] ?? role;
const formatDate = (iso: string): string => esc(iso.slice(0, 16).replace('T', ' ') + ' UTC');
const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`);

function form(action: string, csrf: string, fields: string, button: string, quiet = false): string {
  return `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${fields}<button type="submit"${quiet ? ' class="quiet"' : ''}>${button}</button></form>`;
}

const hiddenField = (name: string, value: string): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

function roleOptions(selected: Role): string {
  return ROLE_LABELS.map(([r, label]) => `<option value="${r}"${r === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function shell(core: Core, admin: User, active: Section, title: string, body: string, msg: Msg = {}): string {
  const csrf = csrfToken(core, admin);
  const nav = `<nav class="tabs" aria-label="Verwaltung">${SECTIONS.map(([id, label]) =>
    `<a href="/admin/${id}"${id === active ? ' aria-current="page" class="current"' : ''}>${label}</a>`).join('')}</nav>`;
  const once = msg.once
    ? `<div class="card" role="status"><strong>${esc(msg.once.title)}</strong><span class="token mono">${esc(msg.once.link)}</span><span class="err">Kopiere den Link jetzt: Er wird nur dieses eine Mal angezeigt.</span></div>` : '';
  return page(`Verwaltung: ${title}`, `<h1>Verwaltung</h1>${nav}
${msg.ok ? `<p class="ok" role="status">${esc(msg.ok)}</p>` : ''}${msg.error ? `<p class="err" role="alert">${esc(msg.error)}</p>` : ''}${once}
<h2>${esc(title)}</h2>${body}`, { wide: true, headerExtra: signedInHeader(admin.email, csrf, true) });
}

function usersSection(core: Core, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const rows = core.users.list().map((u) => {
    const base = `/admin/users/${encodeURIComponent(u.id)}`;
    const status = u.disabled ? 'deaktiviert' : u.verified ? 'aktiv' : 'unbestätigt';
    return `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
<td><form method="post" action="${base}/role" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><select name="role" aria-label="Rolle von ${esc(u.email)}">${roleOptions(u.role)}</select><button type="submit" class="quiet">Speichern</button></form></td>
<td>${status}</td><td>${formatDate(u.createdAt)}</td>
<td><div class="row">${form(`${base}/disabled`, csrf, hiddenField('disabled', u.disabled ? '0' : '1'), u.disabled ? 'Aktivieren' : 'Deaktivieren', true)}
${form(`${base}/reset-link`, csrf, '', 'Rücksetz-Link', true)}</div></td></tr>`;
  }).join('');
  return shell(core, admin, 'users', 'Nutzer', `<div class="scroll"><table><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th>Erstellt</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`, msg);
}

function invitesSection(core: Core, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const now = new Date().toISOString();
  const open = core.accounts.listInvites().filter((i) => !i.used && i.expiresAt > now);
  const rows = open.map((i) => `<tr><td>${i.email ? esc(i.email) : '<span class="muted">beliebig</span>'}</td><td>${esc(roleLabel(i.role))}</td>
<td>${formatDate(i.createdAt)}</td><td>${formatDate(i.expiresAt)}</td>
<td>${form(`/admin/invites/${encodeURIComponent(i.id)}/revoke`, csrf, '', 'Widerrufen', true)}</td></tr>`).join('');
  const body = `<div class="card">${form('/admin/invites', csrf,
    `<label for="invite-email">E-Mail (optional)</label><input id="invite-email" name="email" type="email" maxlength="254" autocomplete="off">
<label for="invite-role">Rolle</label><select id="invite-role" name="role">${roleOptions('user')}</select>`, 'Einladung erstellen')}</div>
${open.length ? `<div class="scroll"><table><thead><tr><th>E-Mail</th><th>Rolle</th><th>Erstellt</th><th>Gültig bis</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">Keine offenen Einladungen.</p>'}`;
  return shell(core, admin, 'invites', 'Einladungen', body, msg);
}

function groupsSection(core: Core, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const groups = core.groups.list();
  const rows = groups.map((g) => `<tr><td><a href="/admin/groups/${encodeURIComponent(g.id)}">${esc(g.name)}</a></td><td>${g.memberCount}</td></tr>`).join('');
  const body = `${groups.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Mitglieder</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Noch keine Gruppen.</p>'}
<div class="card">${form('/admin/groups', csrf, '<label for="group-name">Name der neuen Gruppe</label><input id="group-name" name="name" required maxlength="60">', 'Gruppe erstellen')}</div>`;
  return shell(core, admin, 'groups', 'Gruppen', body, msg);
}

function groupPage(core: Core, admin: User, groupId: string, msg?: Msg): string | null {
  const group = core.groups.get(groupId);
  if (!group) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/groups/${encodeURIComponent(group.id)}`;
  const members = core.groups.members(group.id);
  const rows = members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
<td>${form(`${base}/members/${encodeURIComponent(m.id)}/remove`, csrf, '', 'Entfernen', true)}</td></tr>`).join('');
  const body = `<p><a href="/admin/groups">Alle Gruppen</a></p>
<div class="card">${form(`${base}/rename`, csrf, `<label for="group-name">Name</label><input id="group-name" name="name" required maxlength="60" value="${esc(group.name)}">`, 'Umbenennen')}</div>
<h3>Mitglieder</h3>
${members.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>E-Mail</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Keine Mitglieder.</p>'}
<div class="card">${form(`${base}/members`, csrf, '<label for="member-email">E-Mail des Kontos</label><input id="member-email" name="email" type="email" required maxlength="254">', 'Hinzufügen')}</div>
${form(`${base}/delete`, csrf, '', 'Gruppe löschen', true)}`;
  return shell(core, admin, 'groups', `Gruppe ${group.name}`, body, msg);
}

function settingsSection(core: Core, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const options = MODE_LABELS.map(([m, label]) => `<option value="${m}"${m === core.settings.registration ? ' selected' : ''}>${label}</option>`).join('');
  const body = `<div class="card">${form('/admin/settings', csrf,
    `<label for="registration">Registrierung</label><select id="registration" name="registration">${options}</select>
${core.mailer.enabled ? '' : '<p class="muted">Ohne Mailversand werden E-Mail-Adressen nicht bestätigt.</p>'}
<label for="max-instances">Maximale Instanzen pro Nutzer</label><input id="max-instances" name="maxInstances" type="number" min="1" max="1000" step="1" required value="${core.settings.maxInstancesPerUser}">
<label for="custom-domains">Eigene Domains</label><select id="custom-domains" name="customDomains">${optionList(DOMAIN_LABELS, core.settings.customDomains)}</select>`, 'Speichern')}</div>`;
  return shell(core, admin, 'settings', 'Einstellungen', body, msg);
}

function appsSection(core: Core, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const emailOf = new Map(core.users.list().map((u) => [u.id, u.email]));
  const html = core.apps.listAllApps().map((app) => {
    const rows = core.apps.listInstances(app.id).map((i) => {
      const url = instanceUrl(core.config, i.slug);
      const visibility = i.visibility === 'private' ? 'Privat' : i.visibility === 'users' ? 'Alle Angemeldeten' : 'Öffentlich';
      return `<tr><td><a href="${esc(url)}">${esc(i.slug)}</a></td><td>${esc(emailOf.get(i.ownerId) ?? '–')}</td><td>v${i.activeVersion}</td><td>${visibility}</td>
<td>${formatSize(core.data.usage(i.id))}</td><td>${i.disabled ? '<span class="err">deaktiviert</span>' : 'aktiv'}</td>
<td>${form(`/admin/instances/${encodeURIComponent(i.slug)}/disabled`, csrf, hiddenField('disabled', i.disabled ? '0' : '1'), i.disabled ? 'Aktivieren' : 'Deaktivieren', true)}</td></tr>`;
    }).join('');
    return `<section><h3>${esc(app.title)} <span class="muted mono">${esc(app.slug)}</span> <span class="muted">· ${esc(emailOf.get(app.ownerId) ?? '–')}</span></h3>
${rows ? `<div class="scroll"><table><thead><tr><th>Instanz</th><th>Besitzer</th><th>Version</th><th>Sichtbarkeit</th><th>Daten</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Keine Instanzen.</p>'}</section>`;
  }).join('');
  return shell(core, admin, 'apps', 'Apps', html || '<p class="muted">Noch keine Apps.</p>', msg);
}

/** Platform administrators only: no session goes to /login, any other role gets a 403 page. */
export function requireAdmin(core: Core): RequestHandler {
  const auth = requireUser(core);
  return (req, res, next) => {
    auth(req, res, () => {
      if ((res.locals.user as User).role !== 'admin') {
        res.status(403).type('html').send(forbiddenAdminPage());
        return;
      }
      next();
    });
  };
}

/** Administration area: users, invitations, groups, settings and instance take-down. It never reaches instance content. */
export const adminExtension: PlatformExtension = (router, core) => {
  const admin = requireAdmin(core);
  const formBody = express.urlencoded({ extended: false, limit: '10kb' });
  const noStore: RequestHandler = (_req, res, next) => {
    // Pages here can carry one-time links.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    next();
  };
  const adminOf = (res: Response): User => res.locals.user as User;
  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const send = (res: Response, status: number, body: string): void => { res.status(status).type('html').send(body); };
  const param = (req: Request, name: string): string => String(req.params[name]);

  /** Role check, then CSRF, then the action. */
  const action = (run: (req: Request, res: Response, user: User) => void | Promise<void>): RequestHandler[] => [
    noStore, admin, formBody,
    async (req, res, next) => {
      const user = adminOf(res);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) {
        send(res, 403, page('Fehler', '<h1>Das hat nicht geklappt</h1><p class="err">Die Sitzung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.</p><p><a href="/admin">Zurück zur Verwaltung</a></p>'));
        return;
      }
      try {
        await run(req, res, user);
      } catch (e) {
        next(e);
      }
    },
  ];
  /** Domain error in an action: render `view` again with a German message, status from the error code. */
  const failWith = (res: Response, e: unknown, view: (msg: Msg) => string | null, messages: Partial<Record<string, string>> = {}): void => {
    if (!(e instanceof LagerError)) throw e;
    const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400;
    const error = messages[e.code] ?? 'Die Eingabe ist ungültig.';
    send(res, status, view({ error }) ?? page('Nicht gefunden', '<h1>Nicht gefunden</h1><p>Seite nicht gefunden.</p><p><a href="/admin">Zurück zur Verwaltung</a></p>'));
  };

  const showUsers = (res: Response): void => send(res, 200, usersSection(core, adminOf(res)));
  router.get('/admin', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/users', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/invites', noStore, admin, (_req, res) => { send(res, 200, invitesSection(core, adminOf(res))); });
  router.get('/admin/groups', noStore, admin, (_req, res) => { send(res, 200, groupsSection(core, adminOf(res))); });
  router.get('/admin/groups/:id', noStore, admin, (req, res) => {
    const html = groupPage(core, adminOf(res), param(req, 'id'));
    if (html === null) send(res, 404, page('Nicht gefunden', '<h1>Nicht gefunden</h1><p>Diese Gruppe gibt es nicht.</p><p><a href="/admin/groups">Alle Gruppen</a></p>'));
    else send(res, 200, html);
  });
  router.get('/admin/settings', noStore, admin, (_req, res) => { send(res, 200, settingsSection(core, adminOf(res))); });
  router.get('/admin/apps', noStore, admin, (_req, res) => { send(res, 200, appsSection(core, adminOf(res))); });

  // --- users ---

  const userMessages = { conflict: LAST_ADMIN, not_found: 'Nutzer nicht gefunden.', invalid_argument: 'Ungültige Eingabe.' };

  router.post('/admin/users/:id/role', ...action((req, res, user) => {
    try {
      core.users.setRole(param(req, 'id'), field(req, 'role') as Role);
      res.redirect('/admin/users');
    } catch (e) { failWith(res, e, (m) => usersSection(core, user, m), userMessages); }
  }));

  router.post('/admin/users/:id/disabled', ...action((req, res, user) => {
    const value = field(req, 'disabled');
    try {
      if (value !== '0' && value !== '1') throw new LagerError('invalid_argument', 'disabled must be 0 or 1.');
      core.users.setDisabled(param(req, 'id'), value === '1');
      res.redirect('/admin/users');
    } catch (e) { failWith(res, e, (m) => usersSection(core, user, m), userMessages); }
  }));

  router.post('/admin/users/:id/reset-link', ...action((req, res, user) => {
    try {
      const link = core.accounts.createResetLink(param(req, 'id'));
      send(res, 200, usersSection(core, user, { once: { title: 'Rücksetz-Link (gültig für 1 Stunde)', link } }));
    } catch (e) { failWith(res, e, (m) => usersSection(core, user, m), userMessages); }
  }));

  // --- invitations ---

  router.post('/admin/invites', ...action(async (req, res, user) => {
    const email = field(req, 'email', 254).trim();
    try {
      const { url } = await core.accounts.createInvite({ email: email || undefined, role: field(req, 'role') as Role, createdBy: user.id });
      const mailed = email !== '' && core.mailer.enabled;
      send(res, 200, invitesSection(core, user, {
        once: { title: 'Einladungslink (gültig für 7 Tage)', link: url },
        ok: mailed ? 'Die Einladung wurde per E-Mail gesendet.' : 'Es wurde keine E-Mail gesendet.',
      }));
    } catch (e) { failWith(res, e, (m) => invitesSection(core, user, m), { invalid_argument: 'Bitte gib eine gültige E-Mail-Adresse und eine gültige Rolle an.' }); }
  }));

  router.post('/admin/invites/:id/revoke', ...action((req, res, user) => {
    if (!core.accounts.revokeInvite(param(req, 'id'))) {
      send(res, 404, invitesSection(core, user, { error: 'Einladung nicht gefunden.' }));
      return;
    }
    res.redirect('/admin/invites');
  }));

  // --- groups ---

  const groupMessages = { conflict: 'Eine Gruppe mit diesem Namen gibt es schon.', invalid_argument: 'Der Name muss 1 bis 60 Zeichen lang sein.', not_found: 'Gruppe nicht gefunden.' };

  router.post('/admin/groups', ...action((req, res, user) => {
    try {
      core.groups.create(field(req, 'name'));
      res.redirect('/admin/groups');
    } catch (e) { failWith(res, e, (m) => groupsSection(core, user, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/rename', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.groups.rename(id, field(req, 'name'));
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, user, id, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/members', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      const member = core.users.getByEmail(field(req, 'email', 254));
      if (!member) throw new LagerError('not_found', NO_ACCOUNT);
      core.groups.addMember(id, member.id);
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, user, id, m), { ...groupMessages, not_found: core.groups.get(id) ? NO_ACCOUNT : 'Gruppe nicht gefunden.' }); }
  }));

  router.post('/admin/groups/:id/members/:userId/remove', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.groups.removeMember(id, param(req, 'userId'));
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, user, id, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/delete', ...action((req, res, user) => {
    try {
      core.groups.delete(param(req, 'id'));
      res.redirect('/admin/groups');
    } catch (e) { failWith(res, e, (m) => groupsSection(core, user, m), groupMessages); }
  }));

  // --- settings ---

  router.post('/admin/settings', ...action((req, res, user) => {
    const raw = field(req, 'maxInstances').trim();
    try {
      // Validate both before storing either, so a bad limit does not leave a half-applied change.
      const mode = field(req, 'registration') as RegistrationMode;
      if (!MODE_LABELS.some(([m]) => m === mode)) throw new LagerError('invalid_argument', 'Registration must be open, invite or closed.');
      const max = /^\d+$/.test(raw) ? Number(raw) : NaN;
      // A request without the field (older forms) leaves the setting as it is.
      const domains = (req.body as Record<string, unknown> | undefined)?.customDomains === undefined ? core.settings.customDomains : field(req, 'customDomains') as CustomDomainsMode;
      if (!DOMAIN_LABELS.some(([m]) => m === domains)) throw new LagerError('invalid_argument', 'Custom domains must be admins or publishers.');
      core.settings.setMaxInstancesPerUser(max);
      core.settings.setRegistration(mode);
      core.settings.setCustomDomains(domains);
      res.redirect('/admin/settings');
    } catch (e) { failWith(res, e, (m) => settingsSection(core, user, m), { invalid_argument: 'Bitte wähle einen Registrierungsmodus, gib für die Instanzen eine ganze Zahl von 1 bis 1000 an und wähle, wer eigene Domains setzen darf.' }); }
  }));

  // --- instances ---

  router.post('/admin/instances/:slug/disabled', ...action((req, res, user) => {
    const value = field(req, 'disabled');
    try {
      const instance = core.apps.getInstanceBySlug(param(req, 'slug'));
      if (!instance) throw new LagerError('not_found', 'Instance not found.');
      if (value !== '0' && value !== '1') throw new LagerError('invalid_argument', 'disabled must be 0 or 1.');
      core.apps.setInstanceDisabled(instance.id, value === '1');
      res.redirect('/admin/apps');
    } catch (e) { failWith(res, e, (m) => appsSection(core, user, m), { not_found: 'Instanz nicht gefunden.' }); }
  }));
};
