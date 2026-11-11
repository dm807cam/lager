import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { localeOf } from './locale.js';
import { t, type Locale } from '../i18n/index.js';
import { MAX_NAME } from '../platform/tokens.js';
import { dateText, esc, form, formErrorPage, levelLabel, noticeHtml, page, signedInHeader, visibilityLabel } from './pages.js';
import { csrfToken, csrfValid, readFlash, type Flash } from './session.js';

const deploys = (user: User): boolean => user.role === 'admin' || user.role === 'publisher';

function instanceRows(core: Core, locale: Locale, rows: Array<{ instance: Instance; cells: string; manage: boolean }>): string {
  return rows.map(({ instance: i, cells, manage }) => {
    const title = core.apps.getApp(i.appId)?.title ?? i.slug;
    return `<tr><td>${esc(title)}</td><td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td>${cells}
<td>${manage ? `<a href="/instances/${encodeURIComponent(i.slug)}">${esc(t(locale, 'common.manage'))}</a>` : ''}</td></tr>`;
  }).join('');
}

function ownSection(core: Core, locale: Locale, user: User): string {
  const own = core.apps.listInstancesOwnedBy(user.id);
  if (!own.length) return `<p class="muted">${esc(t(locale, 'dash.noInstances'))}</p>`;
  const rows = instanceRows(core, locale, own.map((instance) => ({
    instance,
    cells: instance.disabled
      ? `<td>v${instance.activeVersion}</td><td><span class="err">${esc(t(locale, 'common.disabled'))}</span></td>`
      : `<td>v${instance.activeVersion}</td><td>${esc(visibilityLabel(locale, instance.visibility))}</td>`,
    manage: core.access.canManageInstance(instance, user) || core.access.canDeleteInstance(instance, user),
  })));
  return `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.app'))}</th><th>${esc(t(locale, 'common.instance'))}</th><th>${esc(t(locale, 'common.version'))}</th><th>${esc(t(locale, 'common.visibility'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function sharedSection(core: Core, locale: Locale, user: User): string {
  const shared = core.access.sharedWith(user);
  if (!shared.length) return '';
  const rows = instanceRows(core, locale, shared.map((instance) => ({
    instance,
    cells: `<td>${esc(levelLabel(locale, core.access.levelFor(instance, user)))}</td>`,
    manage: core.access.canManageInstance(instance, user),
  })));
  return `<h2>${esc(t(locale, 'dash.shared'))}</h2><div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.app'))}</th><th>${esc(t(locale, 'common.instance'))}</th><th>${esc(t(locale, 'dash.yourLevel'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function catalogSection(core: Core, locale: Locale, user: User, csrf: string): string {
  const { instances, apps } = core.access.catalog(user);
  if (!instances.length && !apps.length) return '';
  const instRows = instances.map((i) => `<tr><td>${esc(i.appTitle)}</td>
<td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td><td>${esc(i.ownerName)}</td></tr>`).join('');
  const appCards = apps.map((a) => `<div class="card"><h3>${esc(a.title)} <span class="muted mono">${esc(a.slug)}</span></h3>
${form(`/ui/apps/${encodeURIComponent(a.slug)}/instances`, csrf,
    `<input type="hidden" name="from" value="home"><label for="new-${esc(a.slug)}">${esc(t(locale, 'instance.slugLabel'))}</label><input id="new-${esc(a.slug)}" name="slug" required maxlength="63" autocomplete="off">`,
    esc(t(locale, 'dash.createOwn')))}</div>`).join('');
  return `<h2>${esc(t(locale, 'dash.catalog'))}</h2>${instances.length ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.app'))}</th><th>${esc(t(locale, 'common.instance'))}</th><th>${esc(t(locale, 'common.owner'))}</th></tr></thead><tbody>${instRows}</tbody></table></div>` : ''}${appCards}`;
}

function appsSection(core: Core, locale: Locale, user: User): string {
  const apps = core.access.appsOf(user);
  const rows = apps.map((a) => {
    return `<tr><td>${esc(a.title)}</td><td class="mono">${esc(a.slug)}</td><td>v${core.apps.latestDeployedVersion(a.id)?.number ?? 0}</td>
<td><a href="/apps/${encodeURIComponent(a.slug)}">${esc(t(locale, 'common.open'))}</a></td></tr>`;
  }).join('');
  return `<h2>${esc(t(locale, 'dash.apps'))}</h2>${apps.length
    ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'dash.appTitle'))}</th><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'dash.latestVersion'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'dash.noApps'))}</p>`}`;
}

function tokenSection(core: Core, locale: Locale, user: User, csrf: string, newToken?: { name: string; token: string }): string {
  const tokens = core.tokens.list(user.id);
  const tokenRows = tokens.map((tk) => `<tr><td>${esc(tk.name)}</td><td>${dateText(locale, tk.createdAt)}</td>
<td>${tk.lastUsedAt ? dateText(locale, tk.lastUsedAt) : `<span class="muted">${esc(t(locale, 'common.never'))}</span>`}</td>
<td>${form(`/ui/tokens/${encodeURIComponent(tk.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), true)}</td></tr>`).join('');
  const created = newToken ? `<div class="card" role="status"><strong>${esc(t(locale, 'dash.tokens.created', { name: newToken.name }))}</strong>
<span class="token mono">${esc(newToken.token)}</span><span class="err">${esc(t(locale, 'dash.tokens.copyNow'))}</span></div>` : '';
  return `<h2>${esc(t(locale, 'dash.tokens'))}</h2>${created}
<div class="card">${tokens.length
    ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'common.created'))}</th><th>${esc(t(locale, 'dash.tokens.lastUsed'))}</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'dash.tokens.none'))}</p>`}
${form('/ui/tokens', csrf, `<label for="token-name">${esc(t(locale, 'dash.tokens.nameLabel'))}</label><input id="token-name" name="name" required maxlength="${MAX_NAME}">`, esc(t(locale, 'dash.tokens.create')))}
</div>`;
}

function homePage(core: Core, locale: Locale, user: User, flash: Flash = {}, newToken?: { name: string; token: string }): string {
  const csrf = csrfToken(core, user);
  const publisher = deploys(user) ? `${appsSection(core, locale, user)}
<h2>${esc(t(locale, 'dash.connect'))}</h2>
<div class="card"><p>${esc(t(locale, 'dash.connect.text'))}</p><code>${esc(new URL('/mcp', core.config.publicUrl).href)}</code></div>
${tokenSection(core, locale, user, csrf, newToken)}` : '';
  return page(locale, 'Lager', `<h1>${esc(t(locale, 'nav.overview'))}</h1>${noticeHtml(locale, flash)}
<h2>${esc(t(locale, 'dash.ownInstances'))}</h2>${ownSection(core, locale, user)}
${sharedSection(core, locale, user)}${catalogSection(core, locale, user, csrf)}${publisher}`,
  { wide: true, returnPath: '/', headerExtra: signedInHeader(locale, user.email, csrf, user.role === 'admin') });
}

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

  /** Session, then CSRF, then the action; domain errors render a small error page in the viewer's language. */
  const action = (run: (req: Request, res: Response, user: User) => void): RequestHandler[] => [
    noStore, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      if (!csrfValid(core, user, field(req, 'csrf'))) {
        res.status(403).type('html').send(formErrorPage(localeOf(res), 'error.sessionExpired'));
        return;
      }
      if (!deploys(user)) {
        res.status(403).type('html').send(formErrorPage(localeOf(res), 'dash.tokens.unavailable'));
        return;
      }
      try {
        run(req, res, user);
      } catch (e) {
        if (!(e instanceof LagerError)) throw e;
        const notice = e.code === 'not_found' ? 'dash.tokens.notFound' : e.reason === 'token_name_invalid' ? 'dash.tokens.nameInvalid' : 'validation.generic';
        res.status(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400).type('html').send(formErrorPage(localeOf(res), notice));
      }
    },
  ];

  router.get('/', noStore, auth, (req, res) => {
    const user = userOf(res);
    res.type('html').send(homePage(core, localeOf(res), user, readFlash(core, user, req.query.flash)));
  });

  // The new token is shown on the response to the creating request itself and is never stored in plain text.
  router.post('/ui/tokens', ...action((req, res, user) => {
    const name = field(req, 'name').trim();
    const { token } = core.tokens.create(user.id, name);
    res.type('html').send(homePage(core, localeOf(res), user, {}, { name, token }));
  }));

  router.post('/ui/tokens/:id/revoke', ...action((req, res, user) => {
    if (!core.tokens.revoke(user.id, req.params.id as string)) throw new LagerError('not_found', 'Token not found.');
    res.redirect('/');
  }));
};
