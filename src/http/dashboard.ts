import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl, MAX_SLUG_LENGTH } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { App, Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { localeOf } from './locale.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { MAX_NAME } from '../platform/tokens.js';
import { dateText, esc, field, form, formErrorPage, levelLabel, noticeHtml, page, visibilityLabel } from './pages.js';
import { aiBadge, appCard, badge, btn, named, callout, copyField, dataTable, emptyState, icon, linkButton, section, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid, readFlash, type Flash } from './session.js';

const deploys = (user: User): boolean => user.role === 'admin' || user.role === 'publisher';
const plural = (count: number, one: MessageKey, other: MessageKey): MessageKey => (count === 1 ? one : other);

/** Open (for everyone who reaches the card) and Manage (only for those who may manage or delete the instance). */
function instanceActions(core: Core, locale: Locale, i: Instance, title: string, manage: boolean): string {
  const open = i.disabled ? '' : linkButton(instanceUrl(core.config, i.slug), `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary', true, named(t(locale, 'card.open', { title })));
  const admin = manage ? linkButton(`/instances/${encodeURIComponent(i.slug)}`, `${icon('settings')}<span class="btn-label">${esc(t(locale, 'common.manage'))}</span>`, 'quiet', true, named(t(locale, 'card.manage', { title }))) : '';
  return open + admin;
}

/** Whether a version may ask a language model: it declares `complete` (what `lager.complete()` needs). */
function usesAi(core: Core, appId: string, version: number | undefined): boolean {
  if (version === undefined) return false;
  const complete = core.apps.listVersions(appId).find((v) => v.number === version)?.capabilities.complete;
  return complete !== null && typeof complete === 'object';
}

/** The AI badge for a card, or nothing; instance cards ask about their active version, app cards about the latest deploy. */
const aiCorner = (core: Core, locale: Locale, appId: string, version: number | undefined): string | undefined =>
  usesAi(core, appId, version) ? aiBadge(t(locale, 'card.ai'), t(locale, 'card.ai.hint')) : undefined;

function instanceCard(core: Core, locale: Locale, i: Instance, extra: { badges?: string[]; manage: boolean }): string {
  const app = core.apps.getApp(i.appId);
  const title = app?.title ?? i.slug;
  const state = i.disabled ? badge(t(locale, 'common.disabled'), { tone: 'danger', icon: 'alert' }) : badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) });
  return appCard({
    app, title, slug: i.slug, description: app?.description, corner: aiCorner(core, locale, i.appId, i.activeVersion),
    badges: [state, badge(`v${i.activeVersion}`), ...(extra.badges ?? [])],
    actions: instanceActions(core, locale, i, title, extra.manage),
  });
}

function ownSection(core: Core, locale: Locale, user: User, own: Instance[]): string {
  const body = own.length
    ? `<div class="grid">${own.map((i) => instanceCard(core, locale, i, { manage: core.access.canManageInstance(i, user) || core.access.canDeleteInstance(i, user) })).join('')}</div>`
    : emptyState(t(locale, 'dash.noInstances'));
  return section('mine', t(locale, 'dash.ownInstances'), body, { count: own.length || undefined });
}

function sharedSection(core: Core, locale: Locale, user: User, shared: Instance[]): string {
  if (!shared.length) return '';
  const cards = shared.map((i) => instanceCard(core, locale, i, {
    badges: [badge(t(locale, 'badge.shared', { level: levelLabel(locale, core.access.levelFor(i, user)) }), { icon: 'share', tone: 'accent' })],
    manage: core.access.canManageInstance(i, user),
  })).join('');
  return section('shared', t(locale, 'dash.shared'), `<div class="grid">${cards}</div>`, { count: shared.length });
}

function catalogSection(core: Core, locale: Locale, csrf: string, catalog: ReturnType<Core['access']['catalog']>): string {
  const { instances, apps } = catalog;
  if (!instances.length && !apps.length) return '';
  const instCards = instances.map((i) => {
    const app = core.apps.getApp(i.appId);
    return appCard({
      app, title: i.appTitle, slug: i.slug, description: app?.description, corner: aiCorner(core, locale, i.appId, i.activeVersion),
      badges: [badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) }), badge(i.ownerName, { icon: 'user' })],
      actions: linkButton(instanceUrl(core.config, i.slug), `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary', true, named(t(locale, 'card.open', { title: i.appTitle }))),
    });
  });
  const appCards = apps.map((a) => {
    const id = `new-${esc(a.slug)}`;
    const create = form(`/ui/apps/${encodeURIComponent(a.slug)}/instances`, csrf,
      `<input type="hidden" name="from" value="home">${field(id, t(locale, 'instance.slugLabel'), `<input id="${id}" name="slug" required maxlength="${MAX_SLUG_LENGTH}" autocomplete="off" spellcheck="false">`)}`,
      esc(t(locale, 'dash.createOwn')), 'primary', '', true);
    return appCard({
      app: a, title: a.title, slug: a.slug, description: a.description, badges: [],
      corner: aiCorner(core, locale, a.id, core.apps.latestDeployedVersion(a.id)?.number),
      actions: `<details class="getown"><summary class="${btn('secondary', true)} btn-block">${icon('plus')}${esc(t(locale, 'dash.getOwn'))}</summary>${create}</details>`,
    });
  });
  return section('catalog', t(locale, 'dash.catalog'), `<div class="grid">${[...instCards, ...appCards].join('')}</div>`);
}

function appsSection(core: Core, locale: Locale, apps: App[]): string {
  const cards = apps.map((a) => {
    const latest = core.apps.latestDeployedVersion(a.id)?.number ?? 0;
    const count = core.apps.listInstances(a.id).length;
    return appCard({
      app: a, title: a.title, slug: a.slug, description: a.description, corner: aiCorner(core, locale, a.id, latest || undefined),
      badges: [`<span class="badge"><span class="sr-only">${esc(t(locale, 'dash.latestVersion'))} </span>v${latest}</span>`,
        badge(t(locale, plural(count, 'dash.instanceCount.one', 'dash.instanceCount.other'), { count }), { icon: 'grid' })],
      actions: linkButton(`/apps/${encodeURIComponent(a.slug)}`, `${icon('settings')}${esc(t(locale, 'common.manage'))}`, 'secondary', true, named(t(locale, 'card.manage', { title: a.title }))),
    });
  }).join('');
  return section('apps', t(locale, 'dash.apps'), apps.length ? `<div class="grid">${cards}</div>` : emptyState(t(locale, 'dash.noApps')), { count: apps.length || undefined });
}

/** The three steps from connecting an AI assistant to a running app; the first carries the connector address for those who deploy. */
function steps(locale: Locale, connector: string | null, cls = ''): string {
  return `<ol class="steps${cls ? ` ${cls}` : ''}">
<li><strong>${esc(t(locale, 'dash.connect'))}</strong><span>${esc(t(locale, 'home.step.connect'))}</span>${connector && cls ? copyField(locale, connector) : ''}</li>
<li><strong>${esc(t(locale, 'home.step.ask'))}</strong><span>${esc(t(locale, 'home.step.ask.text'))}</span></li>
<li><strong>${esc(t(locale, 'home.step.appears'))}</strong><span>${esc(t(locale, 'home.step.appears.text'))}</span></li></ol>`;
}

function connectPanel(locale: Locale, connector: string): string {
  return `<section class="section panel-navy" id="connect" aria-labelledby="connect-title"><h2 id="connect-title">${esc(t(locale, 'dash.connect'))}</h2>
<div class="panel-grid"><div><p class="label">${esc(t(locale, 'dash.connect.text'))}</p>${copyField(locale, connector, 'primary')}</div>${steps(locale, null)}</div></section>`;
}

function tokenSection(core: Core, locale: Locale, user: User, csrf: string): string {
  const tokens = core.tokens.list(user.id);
  const rows = tokens.map((tk) => [
    `<strong>${esc(tk.name)}</strong>`, dateText(locale, tk.createdAt),
    tk.lastUsedAt ? dateText(locale, tk.lastUsedAt) : `<span class="muted">${esc(t(locale, 'common.never'))}</span>`,
    form(`/ui/tokens/${encodeURIComponent(tk.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), 'danger', '', true),
  ]);
  const list = tokens.length
    ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'common.created'), t(locale, 'dash.tokens.lastUsed'), ''], rows)
    : emptyState(t(locale, 'dash.tokens.none'), 'lock');
  const create = form('/ui/tokens', csrf,
    field('token-name', t(locale, 'dash.tokens.nameLabel'), `<input id="token-name" name="name" required maxlength="${MAX_NAME}" autocomplete="off">`),
    `${icon('plus')}${esc(t(locale, 'dash.tokens.create'))}`, 'secondary', 'form-row');
  return section('tokens', t(locale, 'dash.tokens'), `<div class="card">${list}<div class="subsection">${create}</div></div>`, { count: tokens.length || undefined });
}

function homePage(core: Core, locale: Locale, user: User, flash: Flash = {}): string {
  const csrf = csrfToken(core, user);
  const publisher = deploys(user);
  const own = core.apps.listInstancesOwnedBy(user.id);
  const shared = core.access.sharedWith(user);
  const catalog = core.access.catalog(user);
  const opts = signedIn(core, user, 'apps', '/');
  if (!own.length && !shared.length && !catalog.instances.length && !catalog.apps.length) {
    const next = publisher
      ? `${steps(locale, new URL('/mcp', core.config.publicUrl).href, 'steps-cards')}<div class="empty-cta">${linkButton('/publish', `${icon('upload')}${esc(t(locale, 'nav.publish'))}`, 'primary')}</div>`
      : `<p class="hint-line">${esc(t(locale, 'dash.noInstances'))} ${esc(t(locale, 'home.empty.user'))}</p>`;
    return page(locale, 'Lager', `${noticeHtml(locale, flash)}<div class="empty-hero"><img src="/icon.webp" alt="" width="96" height="96">
<h1 class="display">${esc(t(locale, 'brand.tagline'))}</h1><p class="lede">${esc(t(locale, 'brand.pitch'))}</p>${next}</div>`, opts);
  }
  const parts = [
    own.length ? t(locale, plural(own.length, 'home.summary.apps.one', 'home.summary.apps.other'), { count: own.length }) : '',
    shared.length ? t(locale, plural(shared.length, 'home.summary.shared.one', 'home.summary.shared.other'), { count: shared.length }) : '',
  ].filter(Boolean);
  return page(locale, 'Lager', `<div class="page-head"><h1 class="display">${esc(t(locale, 'home.title'))}</h1>${parts.length ? `<p class="lede">${esc(parts.join(' · '))}</p>` : ''}</div>
${noticeHtml(locale, flash)}
${ownSection(core, locale, user, own)}${sharedSection(core, locale, user, shared)}${catalogSection(core, locale, csrf, catalog)}`, opts);
}

/** Everything about publishing: the apps the viewer deploys, the MCP connector and the API tokens. */
function publishPage(core: Core, locale: Locale, user: User, newToken?: { name: string; token: string }): string {
  const csrf = csrfToken(core, user);
  const created = newToken ? callout(locale, t(locale, 'dash.tokens.created', { name: newToken.name }), newToken.token, t(locale, 'dash.tokens.copyNow')) : '';
  return page(locale, t(locale, 'nav.publish'), `<div class="page-head"><h1 class="display">${esc(t(locale, 'nav.publish'))}</h1><p class="lede">${esc(t(locale, 'publish.lede'))}</p></div>
${created}${appsSection(core, locale, core.access.appsOf(user))}${connectPanel(locale, new URL('/mcp', core.config.publicUrl).href)}${tokenSection(core, locale, user, csrf)}`,
  signedIn(core, user, 'publish', '/publish'));
}

/** Home page (own and shared instances, catalog), the publish page (apps, connector, API tokens) and the API-token forms. */
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

  // Only those who deploy have anything to publish; everyone else goes home.
  router.get('/publish', noStore, auth, (_req, res) => {
    const user = userOf(res);
    if (!deploys(user)) { res.redirect('/'); return; }
    res.type('html').send(publishPage(core, localeOf(res), user));
  });

  // The new token is shown on the response to the creating request itself and is never stored in plain text.
  router.post('/ui/tokens', ...action((req, res, user) => {
    const name = field(req, 'name').trim();
    const { token } = core.tokens.create(user.id, name);
    res.type('html').send(publishPage(core, localeOf(res), user, { name, token }));
  }));

  router.post('/ui/tokens/:id/revoke', ...action((req, res, user) => {
    if (!core.tokens.revoke(user.id, req.params.id as string)) throw new LagerError('not_found', 'Token not found.');
    res.redirect('/publish');
  }));
};
