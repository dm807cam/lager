import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl, MAX_SLUG_LENGTH } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { App, Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { requireUser, shellFor, type PlatformExtension } from './app.js';
import { localeOf } from './locale.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { MAX_NAME } from '../platform/tokens.js';
import { confirmAttrs, confirmed, questionPage, dateText, esc, field, form, formErrorPage, levelLabel, noticeHtml, page, type Question, slugField, staleFormPage, visibilityLabel, withNotice } from './pages.js';
import { aiBadge, appCard, badge, btn, named, callout, repeatsCardLink, copyField, dataTable, emptyState, icon, linkButton, section, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid, flashUrl, readFlash, type Flash } from './session.js';

const deploys = (user: User): boolean => user.role === 'admin' || user.role === 'publisher';
const plural = (count: number, one: MessageKey, other: MessageKey): MessageKey => (count === 1 ? one : other);

/** Open (for everyone who reaches the card) and Manage (only for those who may manage or delete the instance). */
function instanceActions(core: Core, locale: Locale, i: Instance, title: string, manage: boolean): string {
  const open = i.disabled ? '' : linkButton(instanceUrl(core.config, i.slug), `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary', true, repeatsCardLink);
  const admin = manage ? linkButton(`/instances/${encodeURIComponent(i.slug)}`, `${icon('settings')}<span class="btn-label">${esc(t(locale, 'common.manage'))}</span>`, 'quiet', true, named(t(locale, 'card.manage', { title }))) : '';
  return open + admin;
}

/** Whether a version may ask a language model: it declares `complete` (what `lager.complete()` needs). */
function usesAi(core: Core, appId: string, version: number | undefined): boolean {
  if (version === undefined) return false;
  const complete = core.apps.getVersion(appId, version)?.capabilities.complete;
  return complete !== null && typeof complete === 'object';
}

/** The AI badge for a card, or nothing; instance cards ask about their active version, app cards about the latest deploy. */
const aiCorner = (core: Core, locale: Locale, appId: string, version: number | undefined): string | undefined =>
  usesAi(core, appId, version) ? aiBadge(t(locale, 'card.ai'), t(locale, 'card.ai.hint')) : undefined;

/**
 * An instance as a card. Who may open it and its version are the business of those who manage it, who can change them; to everybody
 * else a "Private" badge on an app shared with them would only be wrong, so they see how it reaches them instead (`extra.badges`).
 */
function instanceCard(core: Core, locale: Locale, i: Instance, extra: { badges?: string[]; manage: boolean }): string {
  const app = core.apps.getApp(i.appId);
  const title = app?.title ?? i.slug;
  const state = i.disabled ? [badge(t(locale, 'common.disabled'), { tone: 'danger', icon: 'alert' })]
    : extra.manage ? [badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) }), badge(`v${i.activeVersion}`)] : [];
  return appCard({
    app, title, slug: i.slug, description: app?.description, corner: aiCorner(core, locale, i.appId, i.activeVersion),
    href: i.disabled ? undefined : instanceUrl(core.config, i.slug), linkLabel: t(locale, 'card.open', { title }),
    badges: [...state, ...(extra.badges ?? [])],
    actions: instanceActions(core, locale, i, title, extra.manage),
  });
}

function ownSection(core: Core, locale: Locale, user: User, own: Instance[], offered: boolean): string {
  const body = own.length
    ? `<div class="grid">${own.map((i) => instanceCard(core, locale, i, { manage: core.access.canManageInstance(i, user) || core.access.canDeleteInstance(i, user) })).join('')}</div>`
    : noOwnApps(locale, deploys(user), offered);
  return section('mine', t(locale, 'dash.ownInstances'), body, { count: own.length || undefined });
}

function sharedSection(core: Core, locale: Locale, user: User, shared: Instance[]): string {
  if (!shared.length) return '';
  const cards = shared.map((i) => instanceCard(core, locale, i, {
    // Whose it is, as on the catalog's cards: two copies of the same app from different people look alike otherwise.
    badges: [badge(t(locale, 'badge.shared', { level: levelLabel(locale, core.access.levelFor(i, user)) }), { icon: 'share', tone: 'accent' }),
      badge(core.users.get(i.ownerId)?.name || '–', { icon: 'user' })],
    manage: core.access.canManageInstance(i, user),
  })).join('');
  return section('shared', t(locale, 'dash.shared'), `<div class="grid">${cards}</div>`, { count: shared.length });
}

/** The catalog's cards: instances the viewer may open, and apps of which they may get their own copy. */
function catalogCards(core: Core, locale: Locale, user: User, csrf: string, catalog: ReturnType<Core['access']['catalog']>, own: Instance[]): { instCards: string[]; appCards: string[] } {
  const { instances, apps } = catalog;
  const instCards = instances.map((i) => {
    const app = core.apps.getApp(i.appId);
    return appCard({
      app, title: i.appTitle, slug: i.slug, description: app?.description, corner: aiCorner(core, locale, i.appId, i.activeVersion),
      href: instanceUrl(core.config, i.slug), linkLabel: t(locale, 'card.open', { title: i.appTitle }),
      badges: [badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) }), badge(i.ownerName, { icon: 'user' })],
      actions: linkButton(instanceUrl(core.config, i.slug), `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary', true, repeatsCardLink),
    });
  });
  const appCards = apps.map((a) => {
    const id = `new-${esc(a.slug)}`;
    // A free name is filled in: getting a copy takes one press.
    const create = form(`/ui/apps/${encodeURIComponent(a.slug)}/instances`, csrf,
      `<input type="hidden" name="from" value="catalog">${slugField(locale, id, t(locale, 'home.copyName'), core.apps.suggestSlug(a, user.id) ?? '', instanceUrl(core.config, '__slug__'))}`,
      esc(t(locale, 'dash.createOwn')), 'primary', '', true);
    // Someone who already has a copy of this app learns so before making another one.
    const copies = own.filter((i) => i.appId === a.id).length;
    return appCard({
      app: a, title: a.title, slug: a.slug, description: a.description,
      badges: copies ? [badge(t(locale, copies === 1 ? 'dash.copies.one' : 'dash.copies.other', { count: copies }), { icon: 'check' })] : [],
      corner: aiCorner(core, locale, a.id, core.apps.latestDeployedVersion(a.id)?.number),
      // withFieldError (pages.ts) finds this panel by `<details class="getown"` to open it again at a refused name: keep it so.
      actions: `<details class="getown"><summary class="${btn('secondary', true)} btn-block">${icon('plus')}${esc(t(locale, 'dash.getOwn'))}</summary>${create}</details>`,
    });
  });
  return { instCards, appCards };
}

/** What the server offers the viewer, on a page of its own: the navigation's Catalog item. */
function catalogPage(core: Core, locale: Locale, user: User, flash: Flash = {}): string {
  const { instCards, appCards } = catalogCards(core, locale, user, csrfToken(core, user), core.access.catalog(user), core.apps.listInstancesOwnedBy(user.id));
  // Two kinds of entries, under headings of their own: the cards' titles are third-level headings.
  const part = (id: string, title: MessageKey, cards: string[]): string => cards.length ? section(id, t(locale, title), `<div class="grid">${cards.join('')}</div>`) : '';
  const body = instCards.length || appCards.length
    ? `<div id="catalog">${part('catalog-open', 'catalog.instances', instCards)}${part('catalog-copy', 'catalog.apps', appCards)}</div>`
    : emptyState(t(locale, 'catalog.none'), 'compass');
  return page(locale, t(locale, 'dash.catalog'), `<div class="page-head"><h1 class="display">${esc(t(locale, 'dash.catalog'))}</h1><p class="lede">${esc(t(locale, 'catalog.lede'))}</p></div>
${withNotice(locale, flash, body)}`, signedIn(core, user, 'catalog', '/catalog'));
}

/** The way from the home page to the catalog, below one's own apps. */
const catalogLink = (locale: Locale): string =>
  `<div class="section-more">${linkButton('/catalog', `${icon('compass')}${esc(t(locale, 'home.catalogLink'))}`, 'secondary')}</div>`;

/** "Yours" without an app: where one comes from, with a button for each way there is (the catalog first, then publishing). */
function noOwnApps(locale: Locale, publisher: boolean, offered: boolean): string {
  // Without a catalog and without Publish, "Yours" is only shown next to apps shared with the viewer (else the start page is).
  const detail: MessageKey = offered ? (publisher ? 'home.empty.catalogPublish' : 'home.empty.catalog') : (publisher ? 'home.empty.publish' : 'home.empty.sharedOnly');
  const action = [
    offered ? linkButton('/catalog', `${icon('compass')}${esc(t(locale, 'home.browseCatalog'))}`, 'primary', true) : '',
    publisher ? linkButton('/publish', `${icon('upload')}${esc(t(locale, 'nav.publish'))}`, offered ? 'secondary' : 'primary', true) : '',
  ].join('');
  return emptyState(t(locale, 'dash.noInstances'), 'grid', { detail: t(locale, detail), action });
}

function appsSection(core: Core, locale: Locale, apps: App[]): string {
  const cards = apps.map((a) => {
    const latest = core.apps.latestDeployedVersion(a.id)?.number ?? 0;
    const count = core.apps.listInstances(a.id).length;
    return appCard({
      app: a, title: a.title, slug: a.slug, description: a.description, corner: aiCorner(core, locale, a.id, latest || undefined),
      href: `/apps/${encodeURIComponent(a.slug)}`, linkLabel: t(locale, 'card.manage', { title: a.title }),
      badges: [`<span class="badge"><span class="sr-only">${esc(t(locale, 'dash.latestVersion'))} </span>v${latest}</span>`,
        badge(t(locale, plural(count, 'dash.instanceCount.one', 'dash.instanceCount.other'), { count }), { icon: 'grid' })],
      actions: linkButton(`/apps/${encodeURIComponent(a.slug)}`, `${icon('settings')}${esc(t(locale, 'common.manage'))}`, 'secondary', true, repeatsCardLink),
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

/** Revoking cannot be taken back: a new token has a new value. */
const revokeQuestion = (locale: Locale, name: string): Question =>
  ({ title: t(locale, 'confirm.tokenRevoke.title', { name }), text: t(locale, 'confirm.tokenRevoke.text'), submit: t(locale, 'common.revoke') });

function tokenSection(core: Core, locale: Locale, user: User, csrf: string): string {
  const tokens = core.tokens.list(user.id);
  const rows = tokens.map((tk) => [
    `<strong>${esc(tk.name)}</strong>`, dateText(locale, tk.createdAt),
    tk.lastUsedAt ? dateText(locale, tk.lastUsedAt) : `<span class="muted">${esc(t(locale, 'common.never'))}</span>`,
    form(`/ui/tokens/${encodeURIComponent(tk.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), 'danger', '', true, confirmAttrs(locale, revokeQuestion(locale, tk.name))),
  ]);
  const list = tokens.length
    ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'common.created'), t(locale, 'dash.tokens.lastUsed'), ''], rows)
    : emptyState(t(locale, 'dash.tokens.none'), 'lock', { detail: t(locale, 'dash.tokens.none.detail') });
  const create = form('/ui/tokens', csrf,
    field('token-name', t(locale, 'dash.tokens.nameLabel'), `<input id="token-name" name="name" required maxlength="${MAX_NAME}" autocomplete="off">`),
    `${icon('plus')}${esc(t(locale, 'dash.tokens.create'))}`, 'secondary', 'form-row');
  return section('tokens', t(locale, 'dash.tokens'), `<div class="card">${list}<div class="subsection">${create}</div></div>`, { count: tokens.length || undefined });
}

function homePage(core: Core, locale: Locale, user: User, flash: Flash = {}): string {
  const publisher = deploys(user);
  const own = core.apps.listInstancesOwnedBy(user.id);
  const shared = core.access.sharedWith(user);
  const catalog = core.access.catalog(user);
  const opts = signedIn(core, user, 'apps', '/');
  const offered = catalog.instances.length + catalog.apps.length > 0;
  if (!own.length && !shared.length && !offered) {
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
${withNotice(locale, flash, `${ownSection(core, locale, user, own, offered)}${sharedSection(core, locale, user, shared)}${offered && own.length ? catalogLink(locale) : ''}`)}`, opts);
}

/** Everything about publishing: the apps the viewer deploys, the MCP connector and the API tokens. */
function publishPage(core: Core, locale: Locale, user: User, newToken?: { name: string; token: string }, flash: Flash = {}): string {
  const csrf = csrfToken(core, user);
  const created = newToken ? callout(locale, t(locale, 'dash.tokens.created', { name: newToken.name }), newToken.token, t(locale, 'dash.tokens.copyNow')) : '';
  return page(locale, t(locale, 'nav.publish'), `<div class="page-head"><h1 class="display">${esc(t(locale, 'nav.publish'))}</h1><p class="lede">${esc(t(locale, 'publish.lede'))}</p></div>
${created}${withNotice(locale, flash, `${appsSection(core, locale, core.access.appsOf(user))}${connectPanel(locale, new URL('/mcp', core.config.publicUrl).href)}${tokenSection(core, locale, user, csrf)}`)}`,
  signedIn(core, user, 'publish', '/publish'));
}

/** Home page (own and shared instances), the catalog, the publish page (apps, connector, API tokens) and the API-token forms. */
export const dashboardExtension: PlatformExtension = (router, core) => {
  const auth = requireUser(core);
  const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const userOf = (res: Response): User => res.locals.user as User;
  /** Error pages keep the navigation: the viewer is signed in on every route here. */
  const shellOf = (res: Response): ReturnType<typeof shellFor> => shellFor(core, res.req, userOf(res));
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
        res.status(403).type('html').send(staleFormPage(localeOf(res), '/publish', shellOf(res)));
        return;
      }
      if (!deploys(user)) {
        res.status(403).type('html').send(formErrorPage(localeOf(res), 'dash.tokens.unavailable', undefined, shellOf(res)));
        return;
      }
      try {
        run(req, res, user);
      } catch (e) {
        if (!(e instanceof LagerError)) throw e;
        const notice = e.code === 'not_found' ? 'dash.tokens.notFound' : e.reason === 'token_name_invalid' ? 'dash.tokens.nameInvalid' : 'validation.generic';
        res.status(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400).type('html').send(formErrorPage(localeOf(res), notice, undefined, shellOf(res)));
      }
    },
  ];

  router.get('/', noStore, auth, (req, res) => {
    const user = userOf(res);
    res.type('html').send(homePage(core, localeOf(res), user, readFlash(core, user, req.query.flash)));
  });

  router.get('/catalog', noStore, auth, (req, res) => {
    const user = userOf(res);
    res.type('html').send(catalogPage(core, localeOf(res), user, readFlash(core, user, req.query.flash)));
  });

  // Only those who deploy have anything to publish; everyone else goes home.
  router.get('/publish', noStore, auth, (req, res) => {
    const user = userOf(res);
    if (!deploys(user)) { res.redirect('/'); return; }
    res.type('html').send(publishPage(core, localeOf(res), user, undefined, readFlash(core, user, req.query.flash)));
  });

  // The new token is shown on the response to the creating request itself and is never stored in plain text.
  router.post('/ui/tokens', ...action((req, res, user) => {
    const name = field(req, 'name').trim();
    let token: string;
    try {
      ({ token } = core.tokens.create(user.id, name));
    } catch (e) {
      // A name the server refuses comes back at the name field, with what was typed.
      if (!(e instanceof LagerError) || e.reason !== 'token_name_invalid') throw e;
      res.redirect(flashUrl(core, user, '/publish', { error: 'dash.tokens.nameInvalid', field: 'token-name', values: { 'token-name': field(req, 'name').slice(0, 300) } }));
      return;
    }
    res.type('html').send(publishPage(core, localeOf(res), user, { name, token }));
  }));

  router.post('/ui/tokens/:id/revoke', ...action((req, res, user) => {
    const name = core.tokens.list(user.id).find((tk) => tk.id === req.params.id)?.name ?? '';
    if (!confirmed(req.body)) {
      if (!name) throw new LagerError('not_found', 'Token not found.');
      res.type('html').send(questionPage(localeOf(res), revokeQuestion(localeOf(res), name), req, csrfToken(core, user), '/publish', shellOf(res)));
      return;
    }
    if (!core.tokens.revoke(user.id, req.params.id as string)) throw new LagerError('not_found', 'Token not found.');
    res.redirect(flashUrl(core, user, '/publish', { ok: 'notice.ok.tokenRevoked', params: { name }, anchor: 'tokens' }));
  }));
};
