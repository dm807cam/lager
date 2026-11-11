import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { App, Instance, SelfInstances, UsersLevel, Visibility } from '../platform/apps.js';
import type { GrantLevel } from '../platform/access.js';
import type { User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import {
  esc, forbiddenInstancePage, form, formatDate, formatSize, hiddenField, LEVEL_LABELS, levelLabel, noticeHtml, optionList, page,
  signedInHeader, VISIBILITY_LABELS,
} from './pages.js';
import { csrfToken, csrfValid, flashToken, readFlash, type Flash } from './session.js';

const NO_ACCOUNT = 'Kein Konto mit dieser E-Mail-Adresse.';
const CONFIRM = 'Zur Bestätigung den Namen eingeben.';
const GRANT_LEVELS = LEVEL_LABELS.filter(([l]) => l !== 'owner');
const USERS_LEVELS = LEVEL_LABELS.filter(([l]) => l === 'view' || l === 'interact');
const SELF_LABELS: Array<[string, string]> = [['off', 'Aus'], ['users', 'Alle Angemeldeten']];
const MAX_FIELD = 300;

/** Fixed German wording for the domain errors a form can run into; raw error text is never shown. */
const NOTICES: Array<[RegExp, string]> = [
  [/^Instanz-Limit erreicht$/, 'Instanz-Limit erreicht'],
  [/^Andere Nutzer haben Instanzen/, 'Andere Nutzer haben Instanzen dieser App. Sie müssen zuerst gelöscht werden.'],
  [/already taken/, 'Dieser Name ist schon vergeben.'],
  [/^Dieser Name wurde bereits verwendet und ist gesperrt\.$/, 'Dieser Name wurde bereits verwendet und ist gesperrt.'],
  [/^Du hast heute zu viele Instanzen angelegt\./, 'Du hast heute zu viele Instanzen angelegt. Versuche es morgen wieder.'],
  [/Invalid slug|is reserved/, 'Ungültiger Name: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 63 Zeichen.'],
  [/Collaborators must be/, 'Mitarbeiter müssen aktive Administratoren oder Publisher sein.'],
  [/owner is already in charge/, 'Der Besitzer ist bereits für die App zuständig.'],
  [/owner already has full access/, 'Der Besitzer hat bereits vollen Zugriff.'],
];

/** A message for the user that is not a domain error (unknown address, wrong confirmation). */
class Notice extends Error {}

const notFoundPage = (what: string): string => page('Nicht gefunden', `<h1>Nicht gefunden</h1><p>${esc(what)}</p><p><a href="/">Zurück zur Übersicht</a></p>`);
const forbiddenAppPage = (): string =>
  page('Kein Zugriff', '<h1>Kein Zugriff</h1><p>Diese App gehört dir nicht und du arbeitest nicht daran mit.</p><p><a href="/">Zurück zur Übersicht</a></p>');
const csrfErrorPage = (): string =>
  page('Fehler', '<h1>Das hat nicht geklappt</h1><p class="err">Die Sitzung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.</p><p><a href="/">Zurück zur Übersicht</a></p>');

function shell(user: User, csrf: string, title: string, body: string, flash: Flash): string {
  return page(title, `${noticeHtml(flash)}${body}`, { wide: true, headerExtra: signedInHeader(user.email, csrf, user.role === 'admin') });
}

function versionsTable(core: Core, app: App, base: string | null, csrf: string, active?: number): string {
  const rows = [...core.apps.listVersions(app.id)].reverse().map((v) => `<tr>
<td>v${v.number}</td><td>${formatDate(v.createdAt)}</td><td>${v.note ? esc(v.note) : '<span class="muted">–</span>'}</td><td>${formatSize(v.sizeBytes)}</td>
${base === null ? '' : `<td>${v.number === active ? '<span class="ok">aktiv</span>' : form(`${base}/activate`, csrf, hiddenField('version', String(v.number)), 'Aktivieren')}</td>`}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>Nr.</th><th>Datum</th><th>Notiz</th><th>Größe</th>${base === null ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function grantsSection(core: Core, inst: Instance, base: string, csrf: string): string {
  const rows = core.access.listGrants(inst.id).map((g) => {
    const who = g.principalType === 'user' ? hiddenField('email', g.principalLabel) : hiddenField('group', g.principalId);
    return `<tr><td>${esc(g.principalLabel)}</td><td>${g.principalType === 'user' ? 'Nutzer' : 'Gruppe'}</td>
<td><form method="post" action="${base}/grants" class="inline">${hiddenField('csrf', csrf)}${who}
<select name="level" aria-label="Stufe von ${esc(g.principalLabel)}">${optionList(GRANT_LEVELS, g.level)}</select><button type="submit" class="quiet">Speichern</button></form></td>
<td>${form(`${base}/grants/remove`, csrf, hiddenField('type', g.principalType) + hiddenField('id', g.principalId), 'Entfernen', true)}</td></tr>`;
  }).join('');
  const groups = core.groups.list().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  return `<h2>Freigaben</h2>${rows ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Art</th><th>Stufe</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">Noch nichts freigegeben.</p>'}
<div class="card">${form(`${base}/grants`, csrf, `<div class="row">
<span><label for="grant-email">E-Mail des Kontos</label><input id="grant-email" name="email" type="email" maxlength="254"></span>
<span><label for="grant-group">oder Gruppe</label><select id="grant-group" name="group"><option value="">–</option>${groups}</select></span>
<span><label for="grant-level">Stufe</label><select id="grant-level" name="level">${optionList(GRANT_LEVELS, 'view')}</select></span></div>`, 'Freigeben')}</div>`;
}

function instancePage(core: Core, user: User, inst: Instance, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/instances/${encodeURIComponent(inst.slug)}`;
  const app = core.apps.getApp(inst.appId)!;
  const url = instanceUrl(core.config, inst.slug);
  const snapshots = core.data.listSnapshots(inst.id);
  const snapRows = snapshots.map((s) => `<tr><td class="mono">${esc(s.label)}</td><td>${formatDate(s.createdAt)}</td><td>${formatSize(s.sizeBytes)}</td>
<td>${form(`${base}/restore`, csrf, hiddenField('snapshot', s.id), 'Wiederherstellen', true)}</td></tr>`).join('');
  const level = inst.visibility === 'users'
    ? `<label for="users-level">Stufe für Angemeldete</label><select id="users-level" name="users_level">${optionList(USERS_LEVELS, inst.usersLevel)}</select>` : '';
  const owner = core.access.canDeleteInstance(inst, user);
  const del = owner ? `<h2>Instanz löschen</h2><div class="card"><p>Die Instanz und ihre Daten werden entfernt. Die Daten landen im Papierkorb des Servers.</p>
${form(`${base}/delete`, csrf, `<label for="confirm">Zur Bestätigung den Namen „${esc(inst.slug)}“ eingeben</label><input id="confirm" name="confirm" required autocomplete="off">`, 'Instanz löschen')}</div>` : '';
  if (inst.disabled) {
    return shell(user, csrf, `Instanz ${inst.slug}`, `<p><a href="/">Zurück zur Übersicht</a></p>
<h1>${esc(app.title)} <span class="muted mono">${esc(inst.slug)}</span></h1>
<p class="err">Diese Instanz wurde von einem Administrator deaktiviert. Du kannst sie nur noch löschen.</p>${del}`, flash);
  }
  return shell(user, csrf, `Instanz ${inst.slug}`, `<p><a href="/">Zurück zur Übersicht</a></p>
<h1>${esc(app.title)} <span class="muted mono">${esc(inst.slug)}</span></h1>
<p><a href="${esc(url)}">${esc(url)}</a></p>
<h2>Version</h2><p>Aktive Version: v${inst.activeVersion}</p>${versionsTable(core, app, base, csrf, inst.activeVersion)}
<h2>Sichtbarkeit</h2><div class="card">${form(`${base}/visibility`, csrf,
    `<label for="visibility">Wer darf die Instanz öffnen?</label><select id="visibility" name="visibility">${optionList(VISIBILITY_LABELS, inst.visibility)}</select>${level}`, 'Speichern')}</div>
${grantsSection(core, inst, base, csrf)}
<h2>Schnappschüsse</h2>${snapshots.length
    ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Datum</th><th>Größe</th><th></th></tr></thead><tbody>${snapRows}</tbody></table></div>`
    : '<p class="muted">Noch keine Schnappschüsse.</p>'}
${del}`, flash);
}

function appPage(core: Core, user: User, app: App, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/apps/${encodeURIComponent(app.slug)}`;
  const rows = core.apps.listInstances(app.id).map((i) => `<tr><td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td>
<td>${esc(core.users.get(i.ownerId)?.email ?? '–')}</td><td>${i.disabled ? '<span class="err">deaktiviert</span>' : core.access.canManageInstance(i, user) ? `<a href="/instances/${encodeURIComponent(i.slug)}">Verwalten</a>` : ''}</td></tr>`).join('');
  const ownerField = core.access.canDeploy(app, user)
    ? '<label for="owner-email">Besitzer (E-Mail), leer für dich selbst</label><input id="owner-email" name="owner_email" type="email" maxlength="254">' : '';
  let ownerOnly = '';
  if (core.access.isAppOwner(app, user)) {
    const collabs = core.apps.listCollaborators(app.id).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td>
<td>${form(`${base}/collaborators/remove`, csrf, hiddenField('id', c.id), 'Entfernen', true)}</td></tr>`).join('');
    ownerOnly = `<h2>Mitarbeiter</h2>${collabs ? `<div class="scroll"><table><thead><tr><th>Name</th><th>E-Mail</th><th></th></tr></thead><tbody>${collabs}</tbody></table></div>` : '<p class="muted">Keine Mitarbeiter.</p>'}
<div class="card">${form(`${base}/collaborators`, csrf, '<label for="collab-email">E-Mail des Kontos (Administrator oder Publisher)</label><input id="collab-email" name="email" type="email" required maxlength="254">', 'Hinzufügen')}</div>
<h2>Selbstbedienung</h2><div class="card">${form(`${base}/self-instances`, csrf,
    `<label for="self-mode">Wer darf eigene Instanzen dieser App anlegen?</label><select id="self-mode" name="mode">${optionList(SELF_LABELS, app.selfInstances)}</select>`, 'Speichern')}</div>
<h2>App löschen</h2><div class="card"><p>Die App mit allen Versionen und Instanzen wird entfernt. Die Dateien landen im Papierkorb des Servers.</p>
${form(`${base}/delete`, csrf, `<label for="confirm">Zur Bestätigung den Namen „${esc(app.slug)}“ eingeben</label><input id="confirm" name="confirm" required autocomplete="off">`, 'App löschen')}</div>`;
  }
  return shell(user, csrf, `App ${app.title}`, `<p><a href="/">Zurück zur Übersicht</a></p>
<h1>${esc(app.title)} <span class="muted mono">${esc(app.slug)}</span></h1>
<h2>Versionen</h2>${versionsTable(core, app, null, csrf)}
<h2>Instanzen</h2>${rows ? `<div class="scroll"><table><thead><tr><th>Instanz</th><th>Besitzer</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Keine Instanzen.</p>'}
<h2>Instanz anlegen</h2><div class="card">${form(`${base}/instances`, csrf,
    `<label for="new-slug">Name der Instanz (Kleinbuchstaben, Ziffern, Bindestriche)</label><input id="new-slug" name="slug" required maxlength="63" autocomplete="off">${ownerField}`, 'Instanz anlegen')}</div>
${ownerOnly}`, flash);
}

/** Pages and forms for one instance (sharing, versions, snapshots, deletion) and for one app (instances, collaborators). */
export const manageExtension: PlatformExtension = (router, core) => {
  const auth = requireUser(core);
  const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const formBody = express.urlencoded({ extended: false, limit: '10kb' });
  const userOf = (res: Response): User => res.locals.user as User;
  const param = (req: Request, name: string): string => String(req.params[name]);
  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const send = (res: Response, status: number, body: string): void => { res.status(status).type('html').send(body); };
  const toPage = (res: Response, user: User, path: string, flash: Flash): void => {
    res.redirect(`${path}?flash=${encodeURIComponent(flashToken(core, user, flash))}`);
  };

  const instanceOf = (slug: string): Instance => {
    const inst = core.apps.getInstanceBySlug(slug);
    if (!inst) throw new LagerError('not_found', 'Instanz nicht gefunden.');
    return inst;
  };
  const appOf = (slug: string): App => {
    const app = core.apps.getApp(slug);
    if (!app) throw new LagerError('not_found', 'App nicht gefunden.');
    return app;
  };
  const managed = (user: User, slug: string): Instance => {
    const inst = instanceOf(slug);
    if (!core.access.canManageInstance(inst, user)) throw new LagerError('forbidden', 'Du darfst diese Instanz nicht verwalten.');
    return inst;
  };
  const ownedApp = (user: User, slug: string): App => {
    const app = appOf(slug);
    if (!core.access.isAppOwner(app, user)) throw new LagerError('forbidden', 'Nur die Besitzerin oder der Besitzer darf das.');
    return app;
  };
  const accountByEmail = (email: string): User => {
    const found = core.users.getByEmail(email.trim());
    if (!found || found.disabled) throw new Notice(NO_ACCOUNT);
    return found;
  };

  /**
   * Session, then CSRF, then the action. `back` is the page the form came from; `run` may return another
   * path to redirect to. Domain errors become a notice on `back`, forbidden and unknown targets error pages.
   */
  const action = (back: (req: Request, user: User) => string, run: (req: Request, user: User) => string | void): RequestHandler[] => [
    noStore, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) { send(res, 403, csrfErrorPage()); return; }
      try {
        const target = run(req, user);
        res.redirect(target ?? back(req, user));
      } catch (e) {
        if (e instanceof Notice) { toPage(res, user, back(req, user), { error: e.message }); return; }
        if (!(e instanceof LagerError)) throw e;
        if (e.code === 'forbidden') send(res, 403, forbiddenInstancePage());
        else if (e.code === 'not_found') send(res, 404, notFoundPage('Das gibt es nicht.'));
        else toPage(res, user, back(req, user), { error: NOTICES.find(([re]) => re.test(e.message))?.[1] ?? 'Die Eingabe ist ungültig.' });
      }
    },
  ];

  // --- instance page ---

  router.get('/instances/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) { send(res, 404, notFoundPage('Diese Instanz gibt es nicht.')); return; }
    if (!core.access.canManageInstance(inst, user) && !core.access.canDeleteInstance(inst, user)) { send(res, 403, forbiddenInstancePage()); return; }
    send(res, 200, instancePage(core, user, inst, readFlash(core, user, req.query.flash)));
  });

  const instBack = (req: Request): string => `/instances/${encodeURIComponent(param(req, 'slug'))}`;

  router.post('/ui/instances/:slug/activate', ...action(instBack, (req, user) => {
    const version = Number(field(req, 'version'));
    if (!Number.isInteger(version)) throw new LagerError('invalid_argument', 'Invalid version.');
    core.apps.activate(managed(user, param(req, 'slug')).id, version, user.id);
  }));

  router.post('/ui/instances/:slug/visibility', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const usersLevel = field(req, 'users_level');
    // Validate before storing either value, so a bad level does not leave a half-applied change.
    if (usersLevel !== '' && !USERS_LEVELS.some(([l]) => l === usersLevel)) throw new LagerError('invalid_argument', 'Invalid level.');
    core.apps.setVisibility(inst.id, field(req, 'visibility') as Visibility, user.id);
    if (usersLevel !== '') core.apps.setUsersLevel(inst.id, usersLevel as UsersLevel, user.id);
  }));

  router.post('/ui/instances/:slug/restore', ...action(instBack, (req, user) => {
    core.data.restore(managed(user, param(req, 'slug')).id, field(req, 'snapshot'));
  }));

  router.post('/ui/instances/:slug/grants', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const level = field(req, 'level') as GrantLevel;
    const email = field(req, 'email', 254).trim();
    const group = field(req, 'group');
    if (email !== '') core.access.setGrant(inst, 'user', accountByEmail(email).id, level, user);
    else if (group !== '') core.access.setGrant(inst, 'group', group, level, user);
    else throw new Notice('Bitte gib eine E-Mail-Adresse an oder wähle eine Gruppe.');
  }));

  router.post('/ui/instances/:slug/grants/remove', ...action(instBack, (req, user) => {
    core.access.removeGrant(managed(user, param(req, 'slug')), field(req, 'type') as 'user' | 'group', field(req, 'id'), user);
  }));

  router.post('/ui/instances/:slug/delete', ...action(instBack, (req, user) => {
    const inst = instanceOf(param(req, 'slug'));
    // Deleting stays with the owner, also while an administrator has disabled the instance.
    if (!core.access.canDeleteInstance(inst, user)) throw new LagerError('forbidden', 'Nur die Besitzerin oder der Besitzer darf das.');
    if (field(req, 'confirm') !== inst.slug) throw new Notice(CONFIRM);
    core.apps.deleteInstance(inst.id, user.id);
    return '/';
  }));

  // --- app page ---

  router.get('/apps/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const app = core.apps.getApp(param(req, 'slug'));
    if (!app) { send(res, 404, notFoundPage('Diese App gibt es nicht.')); return; }
    if (!core.access.canReadApp(app, user)) { send(res, 403, forbiddenAppPage()); return; }
    send(res, 200, appPage(core, user, app, readFlash(core, user, req.query.flash)));
  });

  const appBack = (req: Request): string => `/apps/${encodeURIComponent(param(req, 'slug'))}`;

  router.post('/ui/apps/:slug/instances', ...action(
    (req, user) => {
      const app = core.apps.getApp(param(req, 'slug'));
      return field(req, 'from') !== 'home' && app && core.access.canReadApp(app, user) ? appBack(req) : '/';
    },
    (req, user) => {
      const app = appOf(param(req, 'slug'));
      if (!core.access.canCreateInstance(app, user)) throw new LagerError('forbidden', 'Du darfst keine Instanz dieser App anlegen.');
      const email = field(req, 'owner_email', 254).trim();
      // Only people who deploy this app may create instances for others; for everyone else the field is ignored.
      const owner = email !== '' && core.access.canDeploy(app, user) ? accountByEmail(email) : user;
      core.apps.createInstance({ appId: app.id, slug: field(req, 'slug', 100).trim(), ownerId: owner.id });
    },
  ));

  router.post('/ui/apps/:slug/collaborators', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    core.apps.addCollaborator(app.id, accountByEmail(field(req, 'email', 254)).id, user.id);
  }));

  router.post('/ui/apps/:slug/collaborators/remove', ...action(appBack, (req, user) => {
    core.apps.removeCollaborator(ownedApp(user, param(req, 'slug')).id, field(req, 'id'), user.id);
  }));

  router.post('/ui/apps/:slug/self-instances', ...action(appBack, (req, user) => {
    core.apps.setSelfInstances(ownedApp(user, param(req, 'slug')).id, field(req, 'mode') as SelfInstances, user.id);
  }));

  router.post('/ui/apps/:slug/delete', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    if (field(req, 'confirm') !== app.slug) throw new Notice(CONFIRM);
    core.apps.deleteApp(app.id, user.id);
    return '/';
  }));
};
