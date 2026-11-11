import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf, requestLocale } from './locale.js';
import { MAX_NAME } from '../platform/groups.js';
import type { CustomDomainsMode, RegistrationMode } from '../platform/settings.js';
import type { Instance } from '../platform/apps.js';
import type { Role, User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { noticeText, backLink, dateText, esc, field, forbiddenAdminPage, form, formErrorPage, hiddenField, missingPage, optionList, page, sizeText, visibilityLabel, type Option } from './pages.js';
import { domainsBody } from './manage.js';
import { appTile, avatar, badge, btn, callout, dataTable, emptyState, icon, linkButton, notice, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid } from './session.js';

const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const ROLE_KEYS: Record<Role, MessageKey> = { admin: 'role.admin', publisher: 'role.publisher', user: 'role.user' };
const DOMAIN_KEYS: Record<CustomDomainsMode, MessageKey> = { admins: 'admin.domains.admins', publishers: 'admin.domains.publishers' };
const MODE_KEYS: Record<RegistrationMode, MessageKey> = { open: 'admin.mode.open', invite: 'admin.mode.invite', closed: 'admin.mode.closed' };
const SECTIONS: Array<[Section, MessageKey]> = [['users', 'admin.section.users'], ['invites', 'admin.section.invites'], ['groups', 'admin.section.groups'], ['settings', 'admin.section.settings'], ['apps', 'admin.section.apps']];
const MAX_FIELD = 300;

type Section = 'users' | 'invites' | 'groups' | 'settings' | 'apps';
/** A note above the section; `once` carries a one-time link and is never stored. */
interface Msg { ok?: string; error?: string; once?: { title: string; link: string } }

const roleLabel = (locale: Locale, role: Role): string => t(locale, ROLE_KEYS[role]);
const options = <K extends string>(locale: Locale, keys: Record<K, MessageKey>): Option[] => (Object.keys(keys) as K[]).map((k) => [k, t(locale, keys[k])]);
const roleOptions = (locale: Locale, selected: Role): string => optionList(ROLES.map((r) => [r, roleLabel(locale, r)] as const), selected);

function shell(core: Core, locale: Locale, admin: User, active: Section, title: string, body: string, msg: Msg = {}, returnPath = `/admin/${active}`, back = ''): string {
  const nav = `<nav class="pills" aria-label="${esc(t(locale, 'admin.sections'))}">${SECTIONS.map(([id, key]) =>
    `<a href="/admin/${id}"${id === active ? ' aria-current="page"' : ''}>${esc(t(locale, key))}</a>`).join('')}</nav>`;
  const once = msg.once ? callout(locale, msg.once.title, msg.once.link, t(locale, 'admin.oneTime')) : '';
  return page(locale, t(locale, 'admin.pageTitle', { section: title }), `<div class="page-head"><h1>${esc(t(locale, 'nav.admin'))}</h1>${nav}</div>
${msg.ok ? notice('success', msg.ok) : ''}${msg.error ? notice('danger', msg.error) : ''}${once}${back}
<section class="card" aria-labelledby="admin-section"><h2 id="admin-section">${esc(title)}</h2>${body}</section>`, signedIn(core, admin, 'admin', returnPath));
}

const STATUS_TONES = { disabled: 'danger', active: 'success', unverified: 'warning' } as const;

function usersSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const rows = core.users.list().map((u) => {
    const base = `/admin/users/${encodeURIComponent(u.id)}`;
    const state = u.disabled ? 'disabled' : u.verified ? 'active' : 'unverified';
    const status = t(locale, u.disabled ? 'common.disabled' : u.verified ? 'common.active' : 'common.unverified');
    return [
      `<div class="cell-user">${avatar(u, 'sm')}<div><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></div></div>`,
      `<form method="post" action="${base}/role" class="inline-form">${hiddenField('csrf', csrf)}<select name="role" aria-label="${esc(t(locale, 'admin.users.roleOf', { email: u.email }))}">${roleOptions(locale, u.role)}</select><button type="submit" class="${btn('secondary', true)}">${esc(t(locale, 'common.save'))}</button></form>`,
      badge(status, { tone: STATUS_TONES[state], dot: true }),
      `<span class="num">${dateText(locale, u.createdAt)}</span>`,
      `<div class="btn-row">${form(`${base}/disabled`, csrf, hiddenField('disabled', u.disabled ? '0' : '1'), esc(t(locale, u.disabled ? 'common.activate' : 'common.deactivate')), 'quiet', '', true)}
${form(`${base}/reset-link`, csrf, '', esc(t(locale, 'admin.users.resetLink')), 'quiet', '', true)}</div>`,
    ];
  });
  return shell(core, locale, admin, 'users', t(locale, 'admin.section.users'),
    dataTable([t(locale, 'common.name'), t(locale, 'admin.users.role'), t(locale, 'common.status'), t(locale, 'common.created'), ''], rows), msg);
}

function invitesSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const now = new Date().toISOString();
  const open = core.accounts.listInvites().filter((i) => !i.used && i.expiresAt > now);
  const rows = open.map((i) => [
    i.email ? esc(i.email) : `<span class="muted">${esc(t(locale, 'common.any'))}</span>`, badge(roleLabel(locale, i.role)),
    `<span class="num">${dateText(locale, i.createdAt)}</span>`, `<span class="num">${dateText(locale, i.expiresAt)}</span>`,
    form(`/admin/invites/${encodeURIComponent(i.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), 'danger', '', true),
  ]);
  const create = form('/admin/invites', csrf,
    `${field('invite-email', t(locale, 'admin.invites.email'), '<input id="invite-email" name="email" type="email" maxlength="254" autocomplete="off">')}
${field('invite-role', t(locale, 'admin.invites.role'), `<select id="invite-role" name="role">${roleOptions(locale, 'user')}</select>`)}`,
    `${icon('plus')}${esc(t(locale, 'admin.invites.create'))}`, 'primary', 'form-row');
  const list = open.length
    ? dataTable([t(locale, 'common.email'), t(locale, 'admin.invites.role'), t(locale, 'common.created'), t(locale, 'admin.invites.validUntil'), ''], rows)
    : emptyState(t(locale, 'admin.invites.none'), 'users');
  return shell(core, locale, admin, 'invites', t(locale, 'admin.section.invites'), `${create}<div class="subsection">${list}</div>`, msg);
}

function groupsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const groups = core.groups.list();
  const rows = groups.map((g) => [
    `<div class="cell-user"><span class="tile tile-xs" aria-hidden="true">${icon('users', 'i-sm')}</span><div><a href="/admin/groups/${encodeURIComponent(g.id)}"><strong>${esc(g.name)}</strong></a></div></div>`,
    `<span class="num">${g.memberCount}</span>`,
  ]);
  const body = `${groups.length ? dataTable([t(locale, 'common.name'), t(locale, 'admin.groups.members')], rows) : emptyState(t(locale, 'admin.groups.none'), 'users')}
<div class="subsection">${form('/admin/groups', csrf, field('group-name', t(locale, 'admin.groups.newName'), `<input id="group-name" name="name" required maxlength="${MAX_NAME}" autocomplete="off">`),
    `${icon('plus')}${esc(t(locale, 'admin.groups.create'))}`, 'secondary', 'form-row')}</div>`;
  return shell(core, locale, admin, 'groups', t(locale, 'admin.section.groups'), body, msg);
}

function groupPage(core: Core, locale: Locale, admin: User, groupId: string, msg?: Msg): string | null {
  const group = core.groups.get(groupId);
  if (!group) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/groups/${encodeURIComponent(group.id)}`;
  const members = core.groups.members(group.id);
  const rows = members.map((m) => [
    `<div class="cell-user">${avatar(m, 'sm')}<div><strong>${esc(m.name)}</strong><span>${esc(m.email)}</span></div></div>`,
    form(`${base}/members/${encodeURIComponent(m.id)}/remove`, csrf, '', `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
  ]);
  const body = `${form(`${base}/rename`, csrf, field('group-name', t(locale, 'common.name'), `<input id="group-name" name="name" required maxlength="${MAX_NAME}" value="${esc(group.name)}" autocomplete="off">`), esc(t(locale, 'common.rename')), 'secondary', 'form-row')}
<div class="subsection"><h3>${esc(t(locale, 'admin.groups.members'))}</h3>
${members.length ? dataTable([t(locale, 'common.name'), ''], rows) : emptyState(t(locale, 'admin.groups.noMembers'), 'users')}
<div class="gap-top">${form(`${base}/members`, csrf, field('member-email', t(locale, 'admin.groups.memberEmail'), '<input id="member-email" name="email" type="email" required maxlength="254" autocomplete="off">'),
    `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row')}</div></div>
<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.groups.delete'))}`, 'danger')}</div>`;
  return shell(core, locale, admin, 'groups', t(locale, 'admin.groups.pageTitle', { name: group.name }), body, msg, base,
    `<a class="back" href="/admin/groups">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.groups.all'))}</a>`);
}

/** One setting: label and help text on the left, the control on the right; `control` is trusted markup. */
const settingRow = (id: string, label: string, hint: string, control: string, extra = ''): string =>
  `<div class="settings-row"><div><label for="${esc(id)}">${esc(label)}</label><p class="hint">${esc(hint)}</p>${extra}</div><div>${control}</div></div>`;

function settingsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const body = form('/admin/settings', csrf, `<div>
${settingRow('registration', t(locale, 'admin.settings.registration'), t(locale, 'admin.settings.registration.hint'),
    `<select id="registration" name="registration">${optionList(options(locale, MODE_KEYS), core.settings.registration)}</select>`,
    core.mailer.enabled ? '' : `<p class="hint">${esc(t(locale, 'admin.settings.noMail'))}</p>`)}
${settingRow('max-instances', t(locale, 'admin.settings.maxInstances'), t(locale, 'admin.settings.maxInstances.hint'),
    `<input id="max-instances" name="maxInstances" type="number" inputmode="numeric" min="1" max="1000" step="1" required value="${core.settings.maxInstancesPerUser}">`)}
${settingRow('custom-domains', t(locale, 'admin.settings.customDomains'), t(locale, 'admin.settings.customDomains.hint'),
    `<select id="custom-domains" name="customDomains">${optionList(options(locale, DOMAIN_KEYS), core.settings.customDomains)}</select>`)}
</div>`, esc(t(locale, 'common.save')), 'primary', 'stack settings-form');
  return shell(core, locale, admin, 'settings', t(locale, 'admin.section.settings'), body, msg);
}

function appsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const emailOf = new Map(core.users.list().map((u) => [u.id, u.email]));
  const html = core.apps.listAllApps().map((app) => {
    const rows = core.apps.listInstances(app.id).map((i) => [
      `<a class="mono" href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a>`, esc(emailOf.get(i.ownerId) ?? '–'), `<span class="num">v${i.activeVersion}</span>`,
      badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) }), `<span class="num">${sizeText(locale, core.data.usage(i.id))}</span>`,
      i.disabled ? badge(t(locale, 'common.disabled'), { tone: 'danger', dot: true }) : badge(t(locale, 'common.active'), { tone: 'success', dot: true }),
      `<div class="btn-row">${form(`/admin/instances/${encodeURIComponent(i.slug)}/disabled`, csrf, hiddenField('disabled', i.disabled ? '0' : '1'), esc(t(locale, i.disabled ? 'common.activate' : 'common.deactivate')), 'quiet', '', true)}
${linkButton(`/admin/instances/${encodeURIComponent(i.slug)}/domains`, `${icon('globe')}${esc(t(locale, 'admin.apps.domains'))}`, 'quiet', true)}</div>`,
    ]);
    return `<section class="app-group subsection"><div class="app-group-head">${appTile(app, app.title, 'sm')}<div><h3>${esc(app.title)}</h3><span class="slug">${esc(app.slug)} · ${esc(emailOf.get(app.ownerId) ?? '–')}</span></div></div>
${rows.length ? dataTable([t(locale, 'common.instance'), t(locale, 'common.owner'), t(locale, 'common.version'), t(locale, 'common.visibility'), t(locale, 'admin.apps.data'), t(locale, 'common.status'), ''], rows) : emptyState(t(locale, 'app.noInstances'))}</section>`;
  }).join('');
  return shell(core, locale, admin, 'apps', t(locale, 'admin.section.apps'), html || emptyState(t(locale, 'admin.apps.none')), msg);
}

const DOMAIN_NOTICES: Record<string, MessageKey> = {
  host_invalid: 'notice.hostInvalid', host_taken: 'notice.hostTaken', host_unavailable: 'notice.hostUnavailable', domain_limit: 'notice.domainLimit',
};

/** Custom domains of one instance, handled by an administrator who has no access to the instance itself. */
function domainsPage(core: Core, locale: Locale, admin: User, inst: Instance, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const base = `/admin/instances/${encodeURIComponent(inst.slug)}/domains`;
  return shell(core, locale, admin, 'apps', `${t(locale, 'instance.domains.title')}: ${inst.slug}`, domainsBody(core, locale, inst, base, csrf), msg, base,
    `<a class="back" href="/admin/apps">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.section.apps'))}</a>`);
}

/** Platform administrators only: no session goes to /login, any other role gets a 403 page. */
export function requireAdmin(core: Core): RequestHandler {
  const auth = requireUser(core);
  return (req, res, next) => {
    auth(req, res, () => {
      if ((res.locals.user as User).role !== 'admin') {
        res.status(403).type('html').send(forbiddenAdminPage(requestLocale(core, req, res.locals.user as User)));
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
        send(res, 403, formErrorPage(localeOf(res), 'error.sessionExpired', backLink(localeOf(res), '/admin', t(localeOf(res), 'admin.back'))));
        return;
      }
      try {
        await run(req, res, user);
      } catch (e) {
        next(e);
      }
    },
  ];
  /** Domain error in an action: render `view` again with a message in the viewer's language, status from the error code. */
  const failWith = (res: Response, e: unknown, view: (msg: Msg) => string | null, messages: Partial<Record<string, MessageKey>> = {}): void => {
    if (!(e instanceof LagerError)) throw e;
    const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400;
    const locale = localeOf(res);
    const error = noticeText(locale, messages[e.code] ?? 'validation.generic');
    send(res, status, view({ error }) ?? missingPage(locale, 'error.notFound.text', backLink(locale, '/admin', t(locale, 'admin.back'))));
  };

  const showUsers = (res: Response): void => send(res, 200, usersSection(core, localeOf(res), adminOf(res)));
  router.get('/admin', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/users', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/invites', noStore, admin, (_req, res) => { send(res, 200, invitesSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/groups', noStore, admin, (_req, res) => { send(res, 200, groupsSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/groups/:id', noStore, admin, (req, res) => {
    const html = groupPage(core, localeOf(res), adminOf(res), param(req, 'id'));
    if (html === null) send(res, 404, missingPage(localeOf(res), 'admin.groups.missing', backLink(localeOf(res), '/admin/groups', t(localeOf(res), 'admin.groups.all'))));
    else send(res, 200, html);
  });
  router.get('/admin/settings', noStore, admin, (_req, res) => { send(res, 200, settingsSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/apps', noStore, admin, (_req, res) => { send(res, 200, appsSection(core, localeOf(res), adminOf(res))); });

  const domainInstanceOf = (req: Request): Instance => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) throw new LagerError('not_found', 'Instance not found.');
    return inst;
  };
  const showDomains = (res: Response, inst: Instance, status = 200, msg?: Msg): void => send(res, status, domainsPage(core, localeOf(res), adminOf(res), inst, msg));
  router.get('/admin/instances/:slug/domains', noStore, admin, (req, res) => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) send(res, 404, missingPage(localeOf(res), 'admin.instances.notFound', backLink(localeOf(res), '/admin/apps', t(localeOf(res), 'admin.section.apps'))));
    else showDomains(res, inst);
  });
  for (const [route, change] of [['', 'add'], ['/remove', 'remove']] as const) {
    router.post(`/admin/instances/:slug/domains${route}`, ...action((req, res, user) => {
      try {
        const inst = domainInstanceOf(req);
        core.domains[change](inst, field(req, 'host', MAX_FIELD), user, false);
        res.redirect(`/admin/instances/${encodeURIComponent(inst.slug)}/domains`);
      } catch (e) {
        if (!(e instanceof LagerError)) throw e;
        const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
        const key = (e.reason !== undefined ? DOMAIN_NOTICES[e.reason] : undefined) ?? (e.code === 'not_found' ? 'admin.instances.notFound' : 'validation.generic');
        if (!inst) send(res, 404, missingPage(localeOf(res), 'admin.instances.notFound', backLink(localeOf(res), '/admin/apps', t(localeOf(res), 'admin.section.apps'))));
        else showDomains(res, inst, e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400, { error: noticeText(localeOf(res), key) });
      }
    }));
  }

  // --- users ---

  const userMessages = { conflict: 'admin.users.lastAdmin', not_found: 'admin.users.notFound', invalid_argument: 'validation.generic' } as const;

  router.post('/admin/users/:id/role', ...action((req, res, user) => {
    try {
      core.users.setRole(param(req, 'id'), field(req, 'role') as Role);
      res.redirect('/admin/users');
    } catch (e) { failWith(res, e, (m) => usersSection(core, localeOf(res), user, m), userMessages); }
  }));

  router.post('/admin/users/:id/disabled', ...action((req, res, user) => {
    const value = field(req, 'disabled');
    try {
      if (value !== '0' && value !== '1') throw new LagerError('invalid_argument', 'disabled must be 0 or 1.');
      core.users.setDisabled(param(req, 'id'), value === '1');
      res.redirect('/admin/users');
    } catch (e) { failWith(res, e, (m) => usersSection(core, localeOf(res), user, m), userMessages); }
  }));

  router.post('/admin/users/:id/reset-link', ...action((req, res, user) => {
    try {
      const link = core.accounts.createResetLink(param(req, 'id'));
      send(res, 200, usersSection(core, localeOf(res), user, { once: { title: t(localeOf(res), 'admin.users.resetLinkTitle'), link } }));
    } catch (e) { failWith(res, e, (m) => usersSection(core, localeOf(res), user, m), userMessages); }
  }));

  // --- invitations ---

  router.post('/admin/invites', ...action(async (req, res, user) => {
    const email = field(req, 'email', 254).trim();
    try {
      const { url } = await core.accounts.createInvite({ email: email || undefined, role: field(req, 'role') as Role, createdBy: user.id, locale: localeOf(res) });
      const mailed = email !== '' && core.mailer.enabled;
      send(res, 200, invitesSection(core, localeOf(res), user, {
        once: { title: t(localeOf(res), 'admin.invites.linkTitle'), link: url },
        ok: t(localeOf(res), mailed ? 'admin.invites.mailed' : 'admin.invites.notMailed'),
      }));
    } catch (e) { failWith(res, e, (m) => invitesSection(core, localeOf(res), user, m), { invalid_argument: 'admin.invites.invalid' }); }
  }));

  router.post('/admin/invites/:id/revoke', ...action((req, res, user) => {
    if (!core.accounts.revokeInvite(param(req, 'id'))) {
      send(res, 404, invitesSection(core, localeOf(res), user, { error: t(localeOf(res), 'admin.invites.notFound') }));
      return;
    }
    res.redirect('/admin/invites');
  }));

  // --- groups ---

  const groupMessages = { conflict: 'admin.groups.exists', invalid_argument: 'admin.groups.nameInvalid', not_found: 'admin.groups.notFound' } as const;

  router.post('/admin/groups', ...action((req, res, user) => {
    try {
      core.groups.create(field(req, 'name'));
      res.redirect('/admin/groups');
    } catch (e) { failWith(res, e, (m) => groupsSection(core, localeOf(res), user, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/rename', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.groups.rename(id, field(req, 'name'));
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/members', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      const member = core.users.getByEmail(field(req, 'email', 254));
      if (!member) throw new LagerError('not_found', 'No account with this email address.');
      core.groups.addMember(id, member.id);
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), { ...groupMessages, not_found: core.groups.get(id) ? 'notice.noAccount' : 'admin.groups.notFound' }); }
  }));

  router.post('/admin/groups/:id/members/:userId/remove', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.groups.removeMember(id, param(req, 'userId'));
      res.redirect(`/admin/groups/${encodeURIComponent(id)}`);
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), groupMessages); }
  }));

  router.post('/admin/groups/:id/delete', ...action((req, res, user) => {
    try {
      core.groups.delete(param(req, 'id'));
      res.redirect('/admin/groups');
    } catch (e) { failWith(res, e, (m) => groupsSection(core, localeOf(res), user, m), groupMessages); }
  }));

  // --- settings ---

  router.post('/admin/settings', ...action((req, res, user) => {
    const raw = field(req, 'maxInstances').trim();
    try {
      // Validate both before storing either, so a bad limit does not leave a half-applied change.
      const mode = field(req, 'registration') as RegistrationMode;
      if (!Object.hasOwn(MODE_KEYS, mode)) throw new LagerError('invalid_argument', 'Registration must be open, invite or closed.');
      const max = /^\d+$/.test(raw) ? Number(raw) : NaN;
      // A request without the field (older forms) leaves the setting as it is.
      const domains = (req.body as Record<string, unknown> | undefined)?.customDomains === undefined ? core.settings.customDomains : field(req, 'customDomains') as CustomDomainsMode;
      if (!Object.hasOwn(DOMAIN_KEYS, domains)) throw new LagerError('invalid_argument', 'Custom domains must be admins or publishers.');
      core.settings.setMaxInstancesPerUser(max);
      core.settings.setRegistration(mode);
      core.settings.setCustomDomains(domains);
      res.redirect('/admin/settings');
    } catch (e) { failWith(res, e, (m) => settingsSection(core, localeOf(res), user, m), { invalid_argument: 'admin.settings.invalid' }); }
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
    } catch (e) { failWith(res, e, (m) => appsSection(core, localeOf(res), user, m), { not_found: 'admin.instances.notFound' }); }
  }));
};
