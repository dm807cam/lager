import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { hostUrl, instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf, requestLocale } from './locale.js';
import { MAX_NAME } from '../platform/groups.js';
import type { CustomDomainsMode, RegistrationMode } from '../platform/settings.js';
import type { Instance } from '../platform/apps.js';
import type { Role, User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { noticeText, backLink, dateText, esc, forbiddenAdminPage, form, formErrorPage, hiddenField, missingPage, optionList, page, signedInHeader, sizeText, visibilityLabel, type Option } from './pages.js';
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

function shell(core: Core, locale: Locale, admin: User, active: Section, title: string, body: string, msg: Msg = {}, returnPath = `/admin/${active}`): string {
  const csrf = csrfToken(core, admin);
  const nav = `<nav class="tabs" aria-label="${esc(t(locale, 'nav.admin'))}">${SECTIONS.map(([id, key]) =>
    `<a href="/admin/${id}"${id === active ? ' aria-current="page" class="current"' : ''}>${esc(t(locale, key))}</a>`).join('')}</nav>`;
  const once = msg.once
    ? `<div class="card" role="status"><strong>${esc(msg.once.title)}</strong><span class="token mono">${esc(msg.once.link)}</span><span class="err">${esc(t(locale, 'admin.oneTime'))}</span></div>` : '';
  return page(locale, t(locale, 'admin.pageTitle', { section: title }), `<h1>${esc(t(locale, 'nav.admin'))}</h1>${nav}
${msg.ok ? `<p class="ok" role="status">${esc(msg.ok)}</p>` : ''}${msg.error ? `<p class="err" role="alert">${esc(msg.error)}</p>` : ''}${once}
<h2>${esc(title)}</h2>${body}`, { wide: true, returnPath, headerExtra: signedInHeader(locale, admin.email, csrf, true) });
}

function usersSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const rows = core.users.list().map((u) => {
    const base = `/admin/users/${encodeURIComponent(u.id)}`;
    const status = t(locale, u.disabled ? 'common.disabled' : u.verified ? 'common.active' : 'common.unverified');
    return `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
<td><form method="post" action="${base}/role" class="inline">${hiddenField('csrf', csrf)}<select name="role" aria-label="${esc(t(locale, 'admin.users.roleOf', { email: u.email }))}">${roleOptions(locale, u.role)}</select><button type="submit" class="quiet">${esc(t(locale, 'common.save'))}</button></form></td>
<td>${esc(status)}</td><td>${dateText(locale, u.createdAt)}</td>
<td><div class="row">${form(`${base}/disabled`, csrf, hiddenField('disabled', u.disabled ? '0' : '1'), esc(t(locale, u.disabled ? 'common.activate' : 'common.deactivate')), true)}
${form(`${base}/reset-link`, csrf, '', esc(t(locale, 'admin.users.resetLink')), true)}</div></td></tr>`;
  }).join('');
  return shell(core, locale, admin, 'users', t(locale, 'admin.section.users'), `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'common.email'))}</th><th>${esc(t(locale, 'admin.users.role'))}</th><th>${esc(t(locale, 'common.status'))}</th><th>${esc(t(locale, 'common.created'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`, msg);
}

function invitesSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const now = new Date().toISOString();
  const open = core.accounts.listInvites().filter((i) => !i.used && i.expiresAt > now);
  const rows = open.map((i) => `<tr><td>${i.email ? esc(i.email) : `<span class="muted">${esc(t(locale, 'common.any'))}</span>`}</td><td>${esc(roleLabel(locale, i.role))}</td>
<td>${dateText(locale, i.createdAt)}</td><td>${dateText(locale, i.expiresAt)}</td>
<td>${form(`/admin/invites/${encodeURIComponent(i.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), true)}</td></tr>`).join('');
  const body = `<div class="card">${form('/admin/invites', csrf,
    `<label for="invite-email">${esc(t(locale, 'admin.invites.email'))}</label><input id="invite-email" name="email" type="email" maxlength="254" autocomplete="off">
<label for="invite-role">${esc(t(locale, 'admin.invites.role'))}</label><select id="invite-role" name="role">${roleOptions(locale, 'user')}</select>`, esc(t(locale, 'admin.invites.create')))}</div>
${open.length ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.email'))}</th><th>${esc(t(locale, 'admin.invites.role'))}</th><th>${esc(t(locale, 'common.created'))}</th><th>${esc(t(locale, 'admin.invites.validUntil'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'admin.invites.none'))}</p>`}`;
  return shell(core, locale, admin, 'invites', t(locale, 'admin.section.invites'), body, msg);
}

function groupsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const groups = core.groups.list();
  const rows = groups.map((g) => `<tr><td><a href="/admin/groups/${encodeURIComponent(g.id)}">${esc(g.name)}</a></td><td>${g.memberCount}</td></tr>`).join('');
  const body = `${groups.length ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'admin.groups.members'))}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(t(locale, 'admin.groups.none'))}</p>`}
<div class="card">${form('/admin/groups', csrf, `<label for="group-name">${esc(t(locale, 'admin.groups.newName'))}</label><input id="group-name" name="name" required maxlength="${MAX_NAME}">`, esc(t(locale, 'admin.groups.create')))}</div>`;
  return shell(core, locale, admin, 'groups', t(locale, 'admin.section.groups'), body, msg);
}

function groupPage(core: Core, locale: Locale, admin: User, groupId: string, msg?: Msg): string | null {
  const group = core.groups.get(groupId);
  if (!group) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/groups/${encodeURIComponent(group.id)}`;
  const members = core.groups.members(group.id);
  const rows = members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
<td>${form(`${base}/members/${encodeURIComponent(m.id)}/remove`, csrf, '', esc(t(locale, 'common.remove')), true)}</td></tr>`).join('');
  const body = `<p><a href="/admin/groups">${esc(t(locale, 'admin.groups.all'))}</a></p>
<div class="card">${form(`${base}/rename`, csrf, `<label for="group-name">${esc(t(locale, 'common.name'))}</label><input id="group-name" name="name" required maxlength="${MAX_NAME}" value="${esc(group.name)}">`, esc(t(locale, 'common.rename')))}</div>
<h3>${esc(t(locale, 'admin.groups.members'))}</h3>
${members.length ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'common.email'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(t(locale, 'admin.groups.noMembers'))}</p>`}
<div class="card">${form(`${base}/members`, csrf, `<label for="member-email">${esc(t(locale, 'admin.groups.memberEmail'))}</label><input id="member-email" name="email" type="email" required maxlength="254">`, esc(t(locale, 'common.add')))}</div>
${form(`${base}/delete`, csrf, '', esc(t(locale, 'admin.groups.delete')), true)}`;
  return shell(core, locale, admin, 'groups', t(locale, 'admin.groups.pageTitle', { name: group.name }), body, msg, base);
}

function settingsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const body = `<div class="card">${form('/admin/settings', csrf,
    `<label for="registration">${esc(t(locale, 'admin.settings.registration'))}</label><select id="registration" name="registration">${optionList(options(locale, MODE_KEYS), core.settings.registration)}</select>
${core.mailer.enabled ? '' : `<p class="muted">${esc(t(locale, 'admin.settings.noMail'))}</p>`}
<label for="max-instances">${esc(t(locale, 'admin.settings.maxInstances'))}</label><input id="max-instances" name="maxInstances" type="number" min="1" max="1000" step="1" required value="${core.settings.maxInstancesPerUser}">
<label for="custom-domains">${esc(t(locale, 'admin.settings.customDomains'))}</label><select id="custom-domains" name="customDomains">${optionList(options(locale, DOMAIN_KEYS), core.settings.customDomains)}</select>`, esc(t(locale, 'common.save')))}</div>`;
  return shell(core, locale, admin, 'settings', t(locale, 'admin.section.settings'), body, msg);
}

function appsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const emailOf = new Map(core.users.list().map((u) => [u.id, u.email]));
  const html = core.apps.listAllApps().map((app) => {
    const rows = core.apps.listInstances(app.id).map((i) => {
      const url = instanceUrl(core.config, i.slug);
      return `<tr><td><a href="${esc(url)}">${esc(i.slug)}</a></td><td>${esc(emailOf.get(i.ownerId) ?? '–')}</td><td>v${i.activeVersion}</td><td>${esc(visibilityLabel(locale, i.visibility))}</td>
<td>${sizeText(locale, core.data.usage(i.id))}</td><td>${i.disabled ? `<span class="err">${esc(t(locale, 'common.disabled'))}</span>` : esc(t(locale, 'common.active'))}</td>
<td><div class="row">${form(`/admin/instances/${encodeURIComponent(i.slug)}/disabled`, csrf, hiddenField('disabled', i.disabled ? '0' : '1'), esc(t(locale, i.disabled ? 'common.activate' : 'common.deactivate')), true)}
<a href="/admin/instances/${encodeURIComponent(i.slug)}/domains">${esc(t(locale, 'admin.apps.domains'))}</a></div></td></tr>`;
    }).join('');
    return `<section><h3>${esc(app.title)} <span class="muted mono">${esc(app.slug)}</span> <span class="muted">· ${esc(emailOf.get(app.ownerId) ?? '–')}</span></h3>
${rows ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.instance'))}</th><th>${esc(t(locale, 'common.owner'))}</th><th>${esc(t(locale, 'common.version'))}</th><th>${esc(t(locale, 'common.visibility'))}</th><th>${esc(t(locale, 'admin.apps.data'))}</th><th>${esc(t(locale, 'common.status'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(t(locale, 'app.noInstances'))}</p>`}</section>`;
  }).join('');
  return shell(core, locale, admin, 'apps', t(locale, 'admin.section.apps'), html || `<p class="muted">${esc(t(locale, 'admin.apps.none'))}</p>`, msg);
}

const DOMAIN_NOTICES: Record<string, MessageKey> = {
  host_invalid: 'notice.hostInvalid', host_taken: 'notice.hostTaken', host_unavailable: 'notice.hostUnavailable', domain_limit: 'notice.domainLimit',
};

/** Custom domains of one instance, handled by an administrator who has no access to the instance itself. */
function domainsPage(core: Core, locale: Locale, admin: User, inst: Instance, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const base = `/admin/instances/${encodeURIComponent(inst.slug)}/domains`;
  const rows = core.domains.list(inst.id).map((host) => `<tr><td><a href="${esc(hostUrl(core.config, host))}">${esc(host)}</a></td>
<td>${form(`${base}/remove`, csrf, hiddenField('host', host), esc(t(locale, 'common.remove')), true)}</td></tr>`).join('');
  const body = `${backLink(locale, '/admin/apps', t(locale, 'admin.section.apps'))}
${rows ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'instance.domains.domain'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'instance.domains.none'))}</p>`}
<div class="card">${form(base, csrf, `<label for="domain-host">${esc(t(locale, 'instance.domains.host'))}</label><input id="domain-host" name="host" required maxlength="253" autocomplete="off" placeholder="notes.example.com">
<p class="muted">${esc(t(locale, 'instance.domains.hint'))}</p>`, esc(t(locale, 'common.add')))}</div>`;
  return shell(core, locale, admin, 'apps', `${t(locale, 'instance.domains.title')}: ${inst.slug}`, body, msg, base);
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
