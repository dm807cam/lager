import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { hostUrl, instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf } from './locale.js';
import type { App, Instance, SelfInstances, UsersLevel, Version, Visibility } from '../platform/apps.js';
import type { GrantLevel } from '../platform/access.js';
import type { User } from '../platform/users.js';
import { sendVersionDownload, streamExport, versionParam } from './api.js';
import { requireUser, type PlatformExtension } from './app.js';
import { downloadableVersion } from '../mcp/tools.js';
import {
  dateText, esc, forbiddenAppPage, forbiddenInstancePage, form, formErrorPage, hiddenField, levelOptions, missingPage, noticeHtml, optionList, type Option, page,
  signedInHeader, sizeText, visibilityOptions,
} from './pages.js';
import { csrfToken, csrfValid, flashToken, readFlash, type Flash } from './session.js';

const GRANT_LEVELS = ['view', 'interact', 'admin'] as const;
const USERS_LEVELS = ['view', 'interact'] as const;
const MAX_FIELD = 300;

/** The notice for each domain error a form can run into, keyed by the error's stable `reason`; raw error text is never shown. */
const NOTICES: Record<string, MessageKey> = {
  instance_limit: 'notice.instanceLimit',
  other_users_instances: 'notice.otherUsersInstances',
  slug_taken: 'notice.slugTaken',
  slug_retired: 'notice.slugRetired',
  creation_rate: 'notice.creationRate',
  slug_invalid: 'notice.slugInvalid',
  slug_reserved: 'notice.slugInvalid',
  collaborators_invalid: 'notice.collaboratorsInvalid',
  owner_in_charge: 'notice.ownerInCharge',
  owner_full_access: 'notice.ownerFullAccess',
  host_invalid: 'notice.hostInvalid',
  host_taken: 'notice.hostTaken',
  host_unavailable: 'notice.hostUnavailable',
  domain_limit: 'notice.domainLimit',
};

/** A message for the user that is not a domain error (unknown address, wrong confirmation); carries a catalog key. */
class Notice extends Error {
  constructor(public key: MessageKey) { super(key); }
}

function shell(locale: Locale, user: User, csrf: string, title: string, body: string, flash: Flash, returnPath: string): string {
  return page(locale, title, `${noticeHtml(locale, flash)}${body}`, { wide: true, returnPath, headerExtra: signedInHeader(locale, user.email, csrf, user.role === 'admin') });
}

const overviewLink = (locale: Locale): string => `<p><a href="/">${esc(t(locale, 'common.backToOverview'))}</a></p>`;

/** Deployed versions, plus the ones `instanceId` saved itself; other instances' saved versions are never listed. */
function versionsTable(core: Core, locale: Locale, user: User, app: App, base: string | null, csrf: string, active?: number, instanceId?: string): string {
  const shown = core.apps.listVersions(app.id).filter((v) => v.instanceId === null || v.instanceId === instanceId);
  // The same rule as the download itself: deployed versions for those who read the app, saved ones for the managers of the saving instance.
  const mayDownload = (v: Version): boolean => {
    if (v.instanceId === null) return core.access.canReadApp(app, user);
    const saver = core.apps.getInstance(v.instanceId);
    return saver !== null && core.access.canManageInstance(saver, user);
  };
  const rows = [...shown].reverse().map((v) => `<tr>
<td>v${v.number}</td><td>${dateText(locale, v.createdAt)}</td><td>${v.instanceId !== null ? `<span class="muted">${esc(t(locale, 'instance.savedBySelf'))}</span>` : v.note ? esc(v.note) : '<span class="muted">–</span>'}</td><td>${sizeText(locale, v.sizeBytes)}</td>
<td>${mayDownload(v) ? `<a href="/apps/${encodeURIComponent(app.slug)}/versions/${v.number}/html">${esc(t(locale, 'instance.downloadHtml'))}</a>` : ''}</td>
${base === null ? '' : `<td>${v.number === active ? `<span class="ok">${esc(t(locale, 'common.active'))}</span>` : form(`${base}/activate`, csrf, hiddenField('version', String(v.number)), esc(t(locale, 'common.activate')))}</td>`}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'instance.versionNumber'))}</th><th>${esc(t(locale, 'common.date'))}</th><th>${esc(t(locale, 'instance.versionNote'))}</th><th>${esc(t(locale, 'common.size'))}</th><th></th>${base === null ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function grantsSection(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const grantLevels = levelOptions(locale, GRANT_LEVELS);
  const rows = core.access.listGrants(inst.id).map((g) => {
    const who = g.principalType === 'user' ? hiddenField('email', g.principalLabel) : hiddenField('group', g.principalId);
    return `<tr><td>${esc(g.principalLabel)}</td><td>${esc(t(locale, g.principalType === 'user' ? 'instance.grants.user' : 'instance.grants.group'))}</td>
<td><form method="post" action="${base}/grants" class="inline">${hiddenField('csrf', csrf)}${who}
<select name="level" aria-label="${esc(t(locale, 'instance.grants.levelOf', { name: g.principalLabel }))}">${optionList(grantLevels, g.level)}</select><button type="submit" class="quiet">${esc(t(locale, 'common.save'))}</button></form></td>
<td>${form(`${base}/grants/remove`, csrf, hiddenField('type', g.principalType) + hiddenField('id', g.principalId), esc(t(locale, 'common.remove')), true)}</td></tr>`;
  }).join('');
  const groups = core.groups.list().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  return `<h2>${esc(t(locale, 'instance.grants.title'))}</h2>${rows ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'instance.grants.type'))}</th><th>${esc(t(locale, 'common.level'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'instance.grants.none'))}</p>`}
<div class="card">${form(`${base}/grants`, csrf, `<div class="row">
<span><label for="grant-email">${esc(t(locale, 'instance.grants.email'))}</label><input id="grant-email" name="email" type="email" maxlength="254"></span>
<span><label for="grant-group">${esc(t(locale, 'instance.grants.orGroup'))}</label><select id="grant-group" name="group"><option value="">–</option>${groups}</select></span>
<span><label for="grant-level">${esc(t(locale, 'common.level'))}</label><select id="grant-level" name="level">${optionList(grantLevels, 'view')}</select></span></div>`, esc(t(locale, 'instance.grants.add')))}</div>`;
}

/** Only shown to those who may attach domains. Lager cannot check who owns a DNS name, so the page says so. */
function domainsSection(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const rows = core.domains.list(inst.id).map((host) => `<tr><td><a href="${esc(hostUrl(core.config, host))}">${esc(host)}</a></td>
<td>${form(`${base}/domains/remove`, csrf, hiddenField('host', host), esc(t(locale, 'common.remove')), true)}</td></tr>`).join('');
  return `<h2>${esc(t(locale, 'instance.domains.title'))}</h2>${rows ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'instance.domains.domain'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'instance.domains.none'))}</p>`}
<div class="card">${form(`${base}/domains`, csrf, `<label for="domain-host">${esc(t(locale, 'instance.domains.host'))}</label><input id="domain-host" name="host" required maxlength="253" autocomplete="off" placeholder="notes.example.com">
<p class="muted">${esc(t(locale, 'instance.domains.hint'))}</p>`, esc(t(locale, 'common.add')))}</div>`;
}

function instancePage(core: Core, locale: Locale, user: User, inst: Instance, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/instances/${encodeURIComponent(inst.slug)}`;
  const here = `/instances/${encodeURIComponent(inst.slug)}`;
  const app = core.apps.getApp(inst.appId)!;
  const url = instanceUrl(core.config, inst.slug);
  const title = t(locale, 'instance.pageTitle', { slug: inst.slug });
  const snapshots = core.data.listSnapshots(inst.id);
  const snapRows = snapshots.map((s) => `<tr><td class="mono">${esc(s.label)}</td><td>${dateText(locale, s.createdAt)}</td><td>${sizeText(locale, s.sizeBytes)}</td>
<td>${form(`${base}/restore`, csrf, hiddenField('snapshot', s.id), esc(t(locale, 'instance.snapshots.restore')), true)}</td></tr>`).join('');
  const level = inst.visibility === 'users'
    ? `<label for="users-level">${esc(t(locale, 'instance.usersLevel'))}</label><select id="users-level" name="users_level">${optionList(levelOptions(locale, USERS_LEVELS), inst.usersLevel)}</select>` : '';
  const owner = core.access.canDeleteInstance(inst, user);
  const del = owner ? `<h2>${esc(t(locale, 'instance.delete.title'))}</h2><div class="card"><p>${esc(t(locale, 'instance.delete.text'))}</p>
${form(`${base}/delete`, csrf, `<label for="confirm">${esc(t(locale, 'instance.delete.confirm', { name: inst.slug }))}</label><input id="confirm" name="confirm" required autocomplete="off">`, esc(t(locale, 'instance.delete.submit')))}</div>` : '';
  if (inst.disabled) {
    return shell(locale, user, csrf, title, `${overviewLink(locale)}
<h1>${esc(app.title)} <span class="muted mono">${esc(inst.slug)}</span></h1>
<p class="err">${esc(t(locale, 'instance.disabledNotice'))}</p>${del}`, flash, here);
  }
  return shell(locale, user, csrf, title, `${overviewLink(locale)}
<h1>${esc(app.title)} <span class="muted mono">${esc(inst.slug)}</span></h1>
<p><a href="${esc(url)}">${esc(url)}</a></p>
<h2>${esc(t(locale, 'instance.version'))}</h2><p>${esc(t(locale, 'instance.activeVersion', { number: inst.activeVersion }))}</p>${versionsTable(core, locale, user, app, base, csrf, inst.activeVersion, inst.id)}
<div class="card">${form(`${base}/auto-update`, csrf,
    `${hiddenField('on', '0')}<label><input type="checkbox" name="on" value="1"${inst.autoUpdate ? ' checked' : ''}> ${esc(t(locale, 'instance.autoUpdate.label'))}</label>
<p class="muted">${esc(t(locale, 'instance.autoUpdate.hint'))}</p>`, esc(t(locale, 'common.save')))}</div>
<h2>${esc(t(locale, 'instance.visibility.title'))}</h2><div class="card">${form(`${base}/visibility`, csrf,
    `<label for="visibility">${esc(t(locale, 'instance.visibility.who'))}</label><select id="visibility" name="visibility">${optionList(visibilityOptions(locale), inst.visibility)}</select>${level}`, esc(t(locale, 'common.save')))}</div>
${grantsSection(core, locale, inst, base, csrf)}
${core.domains.canManage(user, core.access.canManageInstance(inst, user)) ? domainsSection(core, locale, inst, base, csrf) : ''}
<h2>${esc(t(locale, 'instance.data.title'))}</h2><div class="card"><p><a href="/instances/${encodeURIComponent(inst.slug)}/export">${esc(t(locale, 'instance.data.export'))}</a></p>
<p class="muted">${esc(t(locale, 'instance.data.hint', { slug: inst.slug }))}</p></div>
<h2>${esc(t(locale, 'instance.snapshots.title'))}</h2>${snapshots.length
    ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'common.date'))}</th><th>${esc(t(locale, 'common.size'))}</th><th></th></tr></thead><tbody>${snapRows}</tbody></table></div>`
    : `<p class="muted">${esc(t(locale, 'instance.snapshots.none'))}</p>`}
${del}`, flash, here);
}

function appPage(core: Core, locale: Locale, user: User, app: App, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/apps/${encodeURIComponent(app.slug)}`;
  const saved = new Map<string, number>();
  for (const v of core.apps.listVersions(app.id)) if (v.instanceId !== null) saved.set(v.instanceId, (saved.get(v.instanceId) ?? 0) + 1);
  const rows = core.apps.listInstances(app.id).map((i) => `<tr><td><a href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a></td>
<td>${esc(core.users.get(i.ownerId)?.email ?? '–')}</td><td>${saved.has(i.id) ? esc(t(locale, 'app.savedCount', { count: saved.get(i.id)! })) : '<span class="muted">–</span>'}</td><td>${i.disabled ? `<span class="err">${esc(t(locale, 'common.disabled'))}</span>` : core.access.canManageInstance(i, user) ? `<a href="/instances/${encodeURIComponent(i.slug)}">${esc(t(locale, 'common.manage'))}</a>` : ''}</td></tr>`).join('');
  const ownerField = core.access.canDeploy(app, user)
    ? `<label for="owner-email">${esc(t(locale, 'app.ownerEmail'))}</label><input id="owner-email" name="owner_email" type="email" maxlength="254">` : '';
  let ownerOnly = '';
  if (core.access.isAppOwner(app, user)) {
    const collabs = core.apps.listCollaborators(app.id).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td>
<td>${form(`${base}/collaborators/remove`, csrf, hiddenField('id', c.id), esc(t(locale, 'common.remove')), true)}</td></tr>`).join('');
    const selfModes: Option[] = [['off', t(locale, 'self.off')], ['users', t(locale, 'self.users')]];
    ownerOnly = `<h2>${esc(t(locale, 'app.collaborators'))}</h2>${collabs ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.name'))}</th><th>${esc(t(locale, 'common.email'))}</th><th></th></tr></thead><tbody>${collabs}</tbody></table></div>` : `<p class="muted">${esc(t(locale, 'app.noCollaborators'))}</p>`}
<div class="card">${form(`${base}/collaborators`, csrf, `<label for="collab-email">${esc(t(locale, 'app.collaboratorEmail'))}</label><input id="collab-email" name="email" type="email" required maxlength="254">`, esc(t(locale, 'common.add')))}</div>
<h2>${esc(t(locale, 'app.self.title'))}</h2><div class="card">${form(`${base}/self-instances`, csrf,
    `<label for="self-mode">${esc(t(locale, 'app.self.label'))}</label><select id="self-mode" name="mode">${optionList(selfModes, app.selfInstances)}</select>`, esc(t(locale, 'common.save')))}</div>
<h2>${esc(t(locale, 'app.delete.title'))}</h2><div class="card"><p>${esc(t(locale, 'app.delete.text'))}</p>
${form(`${base}/delete`, csrf, `<label for="confirm">${esc(t(locale, 'instance.delete.confirm', { name: app.slug }))}</label><input id="confirm" name="confirm" required autocomplete="off">`, esc(t(locale, 'app.delete.submit')))}</div>`;
  }
  return shell(locale, user, csrf, t(locale, 'app.pageTitle', { title: app.title }), `${overviewLink(locale)}
<h1>${esc(app.title)} <span class="muted mono">${esc(app.slug)}</span></h1>
<h2>${esc(t(locale, 'app.versions'))}</h2>${versionsTable(core, locale, user, app, null, csrf)}
<h2>${esc(t(locale, 'app.instances'))}</h2>${rows ? `<div class="scroll"><table><thead><tr><th>${esc(t(locale, 'common.instance'))}</th><th>${esc(t(locale, 'common.owner'))}</th><th>${esc(t(locale, 'app.saved'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(t(locale, 'app.noInstances'))}</p>`}
<h2>${esc(t(locale, 'app.newInstance'))}</h2><div class="card">${form(`${base}/instances`, csrf,
    `<label for="new-slug">${esc(t(locale, 'instance.slugLabel'))}</label><input id="new-slug" name="slug" required maxlength="63" autocomplete="off">${ownerField}`, esc(t(locale, 'app.newInstance')))}</div>
${ownerOnly}`, flash, `/apps/${encodeURIComponent(app.slug)}`);
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
    if (!inst) throw new LagerError('not_found', 'Instance not found.');
    return inst;
  };
  const appOf = (slug: string): App => {
    const app = core.apps.getApp(slug);
    if (!app) throw new LagerError('not_found', 'App not found.');
    return app;
  };
  const managed = (user: User, slug: string): Instance => {
    const inst = instanceOf(slug);
    if (!core.access.canManageInstance(inst, user)) throw new LagerError('forbidden', 'You may not manage this instance.');
    return inst;
  };
  const ownedApp = (user: User, slug: string): App => {
    const app = appOf(slug);
    if (!core.access.isAppOwner(app, user)) throw new LagerError('forbidden', 'Only the owner may do this.');
    return app;
  };
  const accountByEmail = (email: string): User => {
    const found = core.users.getByEmail(email.trim());
    if (!found || found.disabled) throw new Notice('notice.noAccount');
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
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) { send(res, 403, formErrorPage(localeOf(res), 'error.sessionExpired')); return; }
      try {
        const target = run(req, user);
        res.redirect(target ?? back(req, user));
      } catch (e) {
        if (e instanceof Notice) { toPage(res, user, back(req, user), { error: e.key }); return; }
        if (!(e instanceof LagerError)) throw e;
        if (e.code === 'forbidden') send(res, 403, forbiddenInstancePage(localeOf(res)));
        else if (e.code === 'not_found') send(res, 404, missingPage(localeOf(res), 'notice.missing'));
        else toPage(res, user, back(req, user), { error: NOTICES[e.reason ?? ''] ?? 'validation.generic' });
      }
    },
  ];

  // --- instance page ---

  router.get('/instances/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) { send(res, 404, missingPage(localeOf(res), 'notice.instanceMissing')); return; }
    if (!core.access.canManageInstance(inst, user) && !core.access.canDeleteInstance(inst, user)) { send(res, 403, forbiddenInstancePage(localeOf(res))); return; }
    send(res, 200, instancePage(core, localeOf(res), user, inst, readFlash(core, user, req.query.flash)));
  });

  router.get('/instances/:slug/export', noStore, auth, (req, res, next) => {
    const user = userOf(res);
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) { send(res, 404, missingPage(localeOf(res), 'notice.instanceMissing')); return; }
    if (!core.access.canManageInstance(inst, user)) { send(res, 403, forbiddenInstancePage(localeOf(res))); return; }
    streamExport(core, user, inst, res).catch(next);
  });

  router.get('/apps/:slug/versions/:number/html', noStore, auth, (req, res) => {
    const slug = param(req, 'slug');
    try {
      const number = versionParam(req.params.number);
      sendVersionDownload(res, slug, number, downloadableVersion(core, userOf(res), slug, number).html);
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'forbidden') send(res, 403, forbiddenAppPage(localeOf(res)));
      else send(res, 404, missingPage(localeOf(res), 'notice.versionMissing'));
    }
  });

  const instBack = (req: Request): string => `/instances/${encodeURIComponent(param(req, 'slug'))}`;

  router.post('/ui/instances/:slug/activate', ...action(instBack, (req, user) => {
    const version = Number(field(req, 'version'));
    if (!Number.isInteger(version)) throw new LagerError('invalid_argument', 'Invalid version.');
    core.apps.activate(managed(user, param(req, 'slug')).id, version, user.id);
  }));

  router.post('/ui/instances/:slug/auto-update', ...action(instBack, (req, user) => {
    // The form sends a hidden "0" and, when ticked, a "1" as well.
    const raw = (req.body as Record<string, unknown> | undefined)?.on;
    const on = Array.isArray(raw) ? raw.includes('1') : raw === '1';
    core.apps.setAutoUpdate(managed(user, param(req, 'slug')).id, on, user.id);
  }));

  router.post('/ui/instances/:slug/visibility', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const usersLevel = field(req, 'users_level');
    // Validate before storing either value, so a bad level does not leave a half-applied change.
    if (usersLevel !== '' && !(USERS_LEVELS as readonly string[]).includes(usersLevel)) throw new LagerError('invalid_argument', 'Invalid level.');
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
    else throw new Notice('notice.grantTarget');
  }));

  router.post('/ui/instances/:slug/grants/remove', ...action(instBack, (req, user) => {
    core.access.removeGrant(managed(user, param(req, 'slug')), field(req, 'type') as 'user' | 'group', field(req, 'id'), user);
  }));

  router.post('/ui/instances/:slug/domains', ...action(instBack, (req, user) => {
    core.domains.add(managed(user, param(req, 'slug')), field(req, 'host', 300), user, true);
  }));

  router.post('/ui/instances/:slug/domains/remove', ...action(instBack, (req, user) => {
    core.domains.remove(managed(user, param(req, 'slug')), field(req, 'host', 300), user, true);
  }));

  router.post('/ui/instances/:slug/delete', ...action(instBack, (req, user) => {
    const inst = instanceOf(param(req, 'slug'));
    // Deleting stays with the owner, also while an administrator has disabled the instance.
    if (!core.access.canDeleteInstance(inst, user)) throw new LagerError('forbidden', 'Only the owner may do this.');
    if (field(req, 'confirm') !== inst.slug) throw new Notice('notice.confirmName');
    core.apps.deleteInstance(inst.id, user.id);
    return '/';
  }));

  // --- app page ---

  router.get('/apps/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const app = core.apps.getApp(param(req, 'slug'));
    if (!app) { send(res, 404, missingPage(localeOf(res), 'notice.appMissing')); return; }
    if (!core.access.canReadApp(app, user)) { send(res, 403, forbiddenAppPage(localeOf(res))); return; }
    send(res, 200, appPage(core, localeOf(res), user, app, readFlash(core, user, req.query.flash)));
  });

  const appBack = (req: Request): string => `/apps/${encodeURIComponent(param(req, 'slug'))}`;

  router.post('/ui/apps/:slug/instances', ...action(
    (req, user) => {
      const app = core.apps.getApp(param(req, 'slug'));
      return field(req, 'from') !== 'home' && app && core.access.canReadApp(app, user) ? appBack(req) : '/';
    },
    (req, user) => {
      const app = appOf(param(req, 'slug'));
      if (!core.access.canCreateInstance(app, user)) throw new LagerError('forbidden', 'You may not create an instance of this app.');
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
    if (field(req, 'confirm') !== app.slug) throw new Notice('notice.confirmName');
    core.apps.deleteApp(app.id, user.id);
    return '/';
  }));
};
