import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { esc, form, formatDate, levelLabel, noticeHtml, page, signedInHeader, visibilityLabel } from './pages.js';
import { csrfToken, csrfValid, readFlash, type Flash } from './session.js';

const deploys = (user: User): boolean => user.role === 'admin' || user.role === 'publisher';

function instanceRows(core: Core, rows: Array<{ instance: Instance; cells: string; manage: boolean }>): string {
  return rows.map(({ instance: i, cells, manage }) => {
    const title = core.apps.getApp(i.appId)?.title ?? i.slug;
    return `<tr><td>${esc(title)}</td><td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td>${cells}
<td>${manage ? `<a href="/instances/${encodeURIComponent(i.slug)}">Verwalten</a>` : ''}</td></tr>`;
  }).join('');
}

function ownSection(core: Core, user: User): string {
  const own = core.apps.listInstancesOwnedBy(user.id);
  if (!own.length) return '<p class="muted">Du hast noch keine Instanzen.</p>';
  const rows = instanceRows(core, own.map((instance) => ({
    instance,
    cells: instance.disabled
      ? '<td>v' + instance.activeVersion + '</td><td><span class="err">deaktiviert</span></td>'
      : `<td>v${instance.activeVersion}</td><td>${esc(visibilityLabel(instance.visibility))}</td>`,
    manage: core.access.canManageInstance(instance, user),
  })));
  return `<div class="scroll"><table><thead><tr><th>App</th><th>Instanz</th><th>Version</th><th>Sichtbarkeit</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function sharedSection(core: Core, user: User): string {
  const shared = core.access.sharedWith(user);
  if (!shared.length) return '';
  const rows = instanceRows(core, shared.map((instance) => ({
    instance,
    cells: `<td>${esc(levelLabel(core.access.levelFor(instance, user)))}</td>`,
    manage: core.access.canManageInstance(instance, user),
  })));
  return `<h2>Für mich freigegeben</h2><div class="scroll"><table><thead><tr><th>App</th><th>Instanz</th><th>Deine Stufe</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function catalogSection(core: Core, user: User, csrf: string): string {
  const { instances, apps } = core.access.catalog(user);
  if (!instances.length && !apps.length) return '';
  const owner = (i: Instance): string => esc(core.users.get(i.ownerId)?.name ?? '–');
  const instRows = instances.map((i) => `<tr><td>${esc(core.apps.getApp(i.appId)?.title ?? i.slug)}</td>
<td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td><td>${owner(i)}</td></tr>`).join('');
  const appCards = apps.map((a) => `<div class="card"><h3>${esc(a.title)} <span class="muted mono">${esc(a.slug)}</span></h3>
${form(`/ui/apps/${encodeURIComponent(a.slug)}/instances`, csrf,
    `<input type="hidden" name="from" value="home"><label for="new-${esc(a.slug)}">Name der Instanz (Kleinbuchstaben, Ziffern, Bindestriche)</label><input id="new-${esc(a.slug)}" name="slug" required maxlength="63" autocomplete="off">`,
    'Eigene Instanz anlegen')}</div>`).join('');
  return `<h2>Katalog</h2>${instances.length ? `<div class="scroll"><table><thead><tr><th>App</th><th>Instanz</th><th>Besitzer</th></tr></thead><tbody>${instRows}</tbody></table></div>` : ''}${appCards}`;
}

function appsSection(core: Core, user: User): string {
  const apps = core.access.appsOf(user);
  const rows = apps.map((a) => {
    const versions = core.apps.listVersions(a.id);
    return `<tr><td>${esc(a.title)}</td><td class="mono">${esc(a.slug)}</td><td>v${versions.length ? versions[versions.length - 1].number : 0}</td>
<td><a href="/apps/${encodeURIComponent(a.slug)}">Öffnen</a></td></tr>`;
  }).join('');
  return `<h2>Meine Apps</h2>${apps.length
    ? `<div class="scroll"><table><thead><tr><th>Titel</th><th>Name</th><th>Neueste Version</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">Noch keine Apps. Verbinde Claude und lass ein Artefakt deployen.</p>'}`;
}

function tokenSection(core: Core, user: User, csrf: string, newToken?: { name: string; token: string }): string {
  const tokens = core.tokens.list(user.id);
  const tokenRows = tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${formatDate(t.createdAt)}</td>
<td>${t.lastUsedAt ? formatDate(t.lastUsedAt) : '<span class="muted">nie</span>'}</td>
<td>${form(`/ui/tokens/${encodeURIComponent(t.id)}/revoke`, csrf, '', 'Widerrufen', true)}</td></tr>`).join('');
  const created = newToken ? `<div class="card" role="status"><strong>Token „${esc(newToken.name)}“ erstellt.</strong>
<span class="token mono">${esc(newToken.token)}</span><span class="err">Kopiere ihn jetzt: Er wird nur dieses eine Mal angezeigt.</span></div>` : '';
  return `<h2>API-Tokens</h2>${created}
<div class="card">${tokens.length
    ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Erstellt</th><th>Zuletzt benutzt</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
    : '<p class="muted">Noch keine Tokens.</p>'}
${form('/ui/tokens', csrf, '<label for="token-name">Name des neuen Tokens</label><input id="token-name" name="name" required maxlength="100">', 'Token erstellen')}
</div>`;
}

function homePage(core: Core, user: User, flash: Flash = {}, newToken?: { name: string; token: string }): string {
  const csrf = csrfToken(core, user);
  const publisher = deploys(user) ? `${appsSection(core, user)}
<h2>Claude verbinden</h2>
<div class="card"><p>Trage diese Adresse in Claude als benutzerdefinierten Connector ein:</p><code>${esc(new URL('/mcp', core.config.publicUrl).href)}</code></div>
${tokenSection(core, user, csrf, newToken)}` : '';
  return page('Lager', `<h1>Übersicht</h1>${noticeHtml(flash)}
<h2>Meine Instanzen</h2>${ownSection(core, user)}
${sharedSection(core, user)}${catalogSection(core, user, csrf)}${publisher}`,
  { wide: true, headerExtra: signedInHeader(user.email, csrf, user.role === 'admin') });
}

const formErrorPage = (message: string): string =>
  page('Fehler', `<h1>Das hat nicht geklappt</h1><p class="err">${esc(message)}</p><p><a href="/">Zurück zur Übersicht</a></p>`);

/** Home page (overview, shared instances, catalog) and the API-token forms. */
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
      if (!deploys(user)) {
        res.status(403).type('html').send(formErrorPage('API-Tokens sind für deine Rolle nicht verfügbar.'));
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

  router.get('/', noStore, auth, (req, res) => {
    const user = userOf(res);
    res.type('html').send(homePage(core, user, readFlash(core, user, req.query.flash)));
  });

  // The new token is shown on the response to the creating request itself and is never stored in plain text.
  router.post('/ui/tokens', ...action((req, res, user) => {
    const name = field(req, 'name').trim();
    const { token } = core.tokens.create(user.id, name);
    res.type('html').send(homePage(core, user, {}, { name, token }));
  }));

  router.post('/ui/tokens/:id/revoke', ...action((req, res, user) => {
    if (!core.tokens.revoke(user.id, req.params.id as string)) throw new LagerError('not_found', 'Token nicht gefunden.');
    res.redirect('/');
  }));
};
