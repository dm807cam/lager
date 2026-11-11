import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { Instance, Visibility } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { esc, page, signedInHeader } from './pages.js';
import { csrfToken, csrfValid } from './session.js';

const VISIBILITY_LABELS: Array<[Visibility, string]> = [['private', 'Privat'], ['users', 'Alle Angemeldeten'], ['public', 'Öffentlich']];

const formatDate = (iso: string): string => esc(iso.slice(0, 16).replace('T', ' ') + ' UTC');
const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`);

function form(action: string, csrf: string, fields: string, button: string, quiet = false): string {
  return `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${fields}<button type="submit"${quiet ? ' class="quiet"' : ''}>${button}</button></form>`;
}

function instanceHtml(core: Core, inst: Instance, versions: ReturnType<Core['apps']['listVersions']>, csrf: string): string {
  const url = instanceUrl(core.config, inst.slug);
  const base = `/ui/instances/${encodeURIComponent(inst.slug)}`;
  const options = VISIBILITY_LABELS
    .map(([v, label]) => `<option value="${v}"${v === inst.visibility ? ' selected' : ''}>${label}</option>`).join('');
  const rows = [...versions].reverse().map((v) => `<tr>
<td>v${v.number}</td><td>${formatDate(v.createdAt)}</td><td>${v.note ? esc(v.note) : '<span class="muted">–</span>'}</td><td>${formatSize(v.sizeBytes)}</td>
<td>${v.number === inst.activeVersion ? '<span class="ok">aktiv</span>'
    : form(`${base}/activate`, csrf, `<input type="hidden" name="version" value="${v.number}">`, 'Aktivieren')}</td></tr>`).join('');
  const snapshots = core.data.listSnapshots(inst.id);
  const snapRows = snapshots.map((s) => `<tr><td class="mono">${esc(s.label)}</td><td>${formatDate(s.createdAt)}</td><td>${formatSize(s.sizeBytes)}</td>
<td>${form(`${base}/restore`, csrf, `<input type="hidden" name="snapshot" value="${esc(s.id)}">`, 'Wiederherstellen', true)}</td></tr>`).join('');
  return `<div class="card">
<h3><a href="${esc(url)}">${esc(url)}</a></h3>
<div class="row"><span>Aktive Version: v${inst.activeVersion}</span>
<form method="post" action="${base}/visibility"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="vis-${esc(inst.slug)}" class="muted" style="margin:0">Sichtbarkeit</label>
<select id="vis-${esc(inst.slug)}" name="visibility">${options}</select><button type="submit" class="quiet">Speichern</button></form></div>
<h3>Versionen</h3><div class="scroll"><table><thead><tr><th>Nr.</th><th>Datum</th><th>Notiz</th><th>Größe</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>Schnappschüsse der Daten</h3>${snapshots.length
    ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Datum</th><th>Größe</th><th></th></tr></thead><tbody>${snapRows}</tbody></table></div>`
    : '<p class="muted">Noch keine Schnappschüsse.</p>'}
</div>`;
}

function dashboardPage(core: Core, user: User, newToken?: { name: string; token: string }): string {
  const csrf = csrfToken(core, user);
  // Apps the user owns or collaborates on, plus apps of which they only own an instance (self-service).
  const owned = core.apps.listInstancesOwnedBy(user.id);
  const ownedIds = new Set(owned.map((i) => i.id));
  const apps = new Map(core.access.appsOf(user).map((a) => [a.id, a]));
  for (const i of owned) {
    const app = core.apps.getApp(i.appId);
    if (app) apps.set(app.id, app);
  }
  const appsHtml = apps.size ? [...apps.values()].sort((x, y) => x.slug.localeCompare(y.slug)).map((app) => {
    const versions = core.apps.listVersions(app.id);
    const instances = core.apps.listInstances(app.id).filter((i) => ownedIds.has(i.id) || core.access.canManageInstance(i, user));
    const html = instances.map((i) => (i.disabled
      ? `<div class="card"><h3>${esc(instanceUrl(core.config, i.slug))}</h3><p class="err">Diese Instanz wurde deaktiviert.</p></div>`
      : instanceHtml(core, i, versions, csrf))).join('');
    return `<section><h3>${esc(app.title)} <span class="muted mono">${esc(app.slug)}</span></h3>${html}</section>`;
  }).join('') : '<p>Noch keine Apps. Verbinde Claude und lass ein Artefakt deployen.</p>';

  const tokens = core.tokens.list(user.id);
  const tokenRows = tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${formatDate(t.createdAt)}</td>
<td>${t.lastUsedAt ? formatDate(t.lastUsedAt) : '<span class="muted">nie</span>'}</td>
<td>${form(`/ui/tokens/${encodeURIComponent(t.id)}/revoke`, csrf, '', 'Widerrufen', true)}</td></tr>`).join('');
  const created = newToken ? `<div class="card" role="status"><strong>Token „${esc(newToken.name)}“ erstellt.</strong>
<span class="token mono">${esc(newToken.token)}</span><span class="err">Kopiere ihn jetzt: Er wird nur dieses eine Mal angezeigt.</span></div>` : '';

  const headerExtra = signedInHeader(user.email, csrf);
  return page('Lager', `<h1>Übersicht</h1>
<h2>Claude verbinden</h2>
<div class="card"><p>Trage diese Adresse in Claude als benutzerdefinierten Connector ein:</p><code>${esc(new URL('/mcp', core.config.publicUrl).href)}</code></div>
<h2>Apps</h2>${appsHtml}
<h2>API-Tokens</h2>${created}
<div class="card">${tokens.length
    ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Erstellt</th><th>Zuletzt benutzt</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
    : '<p class="muted">Noch keine Tokens.</p>'}
${form('/ui/tokens', csrf, '<label for="token-name">Name des neuen Tokens</label><input id="token-name" name="name" required maxlength="100">', 'Token erstellen')}
</div>`, { wide: true, headerExtra });
}

const formErrorPage = (message: string): string =>
  page('Fehler', `<h1>Das hat nicht geklappt</h1><p class="err">${esc(message)}</p><p><a href="/">Zurück zur Übersicht</a></p>`);

export const dashboardExtension: PlatformExtension = (router, core) => {
  const auth = requireUser(core);
  const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const userOf = (res: Response): User => res.locals.user as User;
  const formBody = express.urlencoded({ extended: false, limit: '10kb' });
  const field = (req: Request, name: string): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v : '';
  };

  /** Session, then CSRF, then the action; domain errors render a small German error page. */
  const action = (run: (req: Request, res: Response, user: User) => void): RequestHandler[] => [
    noStore, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      if (!csrfValid(core, user, field(req, 'csrf'))) {
        res.status(403).type('html').send(formErrorPage('Die Sitzung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.'));
        return;
      }
      try {
        run(req, res, user);
      } catch (e) {
        if (!(e instanceof LagerError)) throw e;
        res.status(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400).type('html').send(formErrorPage(e.message));
      }
    },
  ];

  const managedInstance = (user: User, slug: unknown): Instance => {
    const inst = typeof slug === 'string' ? core.apps.getInstanceBySlug(slug) : null;
    if (!inst) throw new LagerError('not_found', 'Instanz nicht gefunden.');
    if (!core.access.canManageInstance(inst, user)) throw new LagerError('forbidden', 'Du darfst diese Instanz nicht verwalten.');
    return inst;
  };

  router.get('/', noStore, auth, (_req, res) => {
    res.type('html').send(dashboardPage(core, userOf(res)));
  });

  router.post('/ui/instances/:slug/activate', ...action((req, res, user) => {
    const version = Number(field(req, 'version'));
    if (!Number.isInteger(version)) throw new LagerError('invalid_argument', 'Ungültige Version.');
    core.apps.activate(managedInstance(user, req.params.slug).id, version, user.id);
    res.redirect('/');
  }));

  router.post('/ui/instances/:slug/visibility', ...action((req, res, user) => {
    core.apps.setVisibility(managedInstance(user, req.params.slug).id, field(req, 'visibility') as Visibility, user.id);
    res.redirect('/');
  }));

  router.post('/ui/instances/:slug/restore', ...action((req, res, user) => {
    core.data.restore(managedInstance(user, req.params.slug).id, field(req, 'snapshot'));
    res.redirect('/');
  }));

  // The new token is shown on the response to the creating request itself and is never stored in plain text.
  router.post('/ui/tokens', ...action((req, res, user) => {
    const name = field(req, 'name').trim();
    const { token } = core.tokens.create(user.id, name);
    res.type('html').send(dashboardPage(core, user, { name, token }));
  }));

  router.post('/ui/tokens/:id/revoke', ...action((req, res, user) => {
    if (!core.tokens.revoke(user.id, req.params.id as string)) throw new LagerError('not_found', 'Token nicht gefunden.');
    res.redirect('/');
  }));
};
