import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { hostUrl, instanceUrl, MAX_SLUG_LENGTH } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { countSnapshotAction } from './snapshot-limit.js';
import { formatSize, t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf } from './locale.js';
import type { App, Instance, SelfInstances, UsersLevel, Version, Visibility } from '../platform/apps.js';
import type { GrantLevel } from '../platform/access.js';
import type { User } from '../platform/users.js';
import { sendVersionDownload, streamExport, versionParam } from './api.js';
import { requireUser, type PlatformExtension } from './app.js';
import { declaredModel, downloadableVersion, setAppModel } from '../mcp/tools.js';
import {
  dateText, esc, field, forbiddenAppPage, forbiddenInstancePage, form, formErrorPage, hiddenField, levelOptions, missingPage, noticeHtml, optionList, type Option, page,
  sizeText, visibilityLabel, visibilityOptions,
} from './pages.js';
import { appTile, avatar, badge, btn, named, card, dataTable, emptyState, icon, linkButton, meter, notice, signedIn, visibilityIcon } from './ui.js';
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
  rules_differ: 'notice.rulesDiffer',
  creation_rate: 'notice.creationRate',
  snapshot_rate: 'notice.snapshotRate',
  slug_invalid: 'notice.slugInvalid',
  slug_reserved: 'notice.slugInvalid',
  collaborators_invalid: 'notice.collaboratorsInvalid',
  owner_in_charge: 'notice.ownerInCharge',
  model_not_allowed: 'notice.modelNotAllowed',
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

/** Instance pages belong to "Apps", app pages to "Publish"; the back link leads there. */
function shell(core: Core, locale: Locale, user: User, title: string, body: string, flash: Flash, returnPath: string, section: 'apps' | 'publish' = 'apps'): string {
  const back = section === 'publish' && (user.role === 'admin' || user.role === 'publisher')
    ? backTo('/publish', t(locale, 'nav.publish')) : backTo('/', t(locale, 'common.backToOverview'));
  return page(locale, title, `${back}${noticeHtml(locale, flash)}${body}`, signedIn(core, user, section, returnPath));
}

const backTo = (href: string, label: string): string => `<a class="back" href="${esc(href)}">${icon('chevron', 'i-sm')}${esc(label)}</a>`;

/** The band at the top of an instance or app page: icon, title, address and badges; `actions` and `badges` are trusted markup. */
const THEME_COLOR = /^#[0-9a-f]{6}$/i;

function hero(app: App, title: string, sub: string, badges: string[], actions: string, description = ''): string {
  // The colour goes into a style attribute: only a plain hex colour is ever written there, whatever the store holds.
  const colour = THEME_COLOR.test(app.themeColor) ? app.themeColor : '#1f2a5c';
  return `<header class="hero" style="--app:${colour}">${appTile(app, title, 'lg')}<div class="hero-main"><h1>${esc(title)}</h1>${sub}
${description ? `<p class="hero-desc">${esc(description)}</p>` : ''}<div class="badges">${badges.join('')}</div></div>${actions ? `<div class="hero-actions">${actions}</div>` : ''}</header>`;
}

/** Deployed versions, plus the ones `instanceId` saved itself; other instances' saved versions are never listed. */
function versionsList(core: Core, locale: Locale, user: User, app: App, base: string | null, csrf: string, active?: number, instanceId?: string): string {
  const shown = core.apps.listVersions(app.id).filter((v) => v.instanceId === null || v.instanceId === instanceId);
  // The same rule as the download itself: deployed versions for those who read the app, saved ones for the managers of the saving instance.
  const mayDownload = (v: Version): boolean => {
    if (v.instanceId === null) return core.access.canReadApp(app, user);
    const saver = core.apps.getInstance(v.instanceId);
    return saver !== null && core.access.canManageInstance(saver, user);
  };
  if (!shown.length) return emptyState(t(locale, 'notice.versionMissing'));
  const items = [...shown].reverse().map((v) => {
    const isActive = v.number === active;
    const note = v.instanceId !== null ? badge(t(locale, 'instance.savedBySelf'), { icon: 'user' }) : '';
    const download = mayDownload(v)
      ? linkButton(`/apps/${encodeURIComponent(app.slug)}/versions/${v.number}/html`, `${icon('download')}${esc(t(locale, 'instance.downloadHtml'))}`, 'quiet', true) : '';
    const activate = base === null || isActive ? '' : form(`${base}/activate`, csrf, hiddenField('version', String(v.number)), esc(t(locale, 'common.activate')), 'secondary', '', true);
    return `<li data-version="${v.number}"${isActive ? ' class="is-active"' : ''}><span class="dot" aria-hidden="true"></span>
<div class="tl-body"><div class="tl-title"><strong>v${v.number}</strong>${isActive ? badge(t(locale, 'common.active'), { tone: 'success', dot: true }) : ''}${note}</div>
<span class="tl-meta">${dateText(locale, v.createdAt)} · ${sizeText(locale, v.sizeBytes)}</span>${v.instanceId === null && v.note ? `<span class="tl-note">${esc(v.note)}</span>` : ''}</div>
<div class="tl-actions">${download}${activate}</div></li>`;
  }).join('');
  return `<ol class="timeline">${items}</ol>`;
}

function grantsCard(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const grantLevels = levelOptions(locale, GRANT_LEVELS);
  const rows = core.access.listGrants(inst.id).map((g) => {
    const who = g.principalType === 'user' ? hiddenField('email', g.principalLabel) : hiddenField('group', g.principalId);
    const face = g.principalType === 'user' ? avatar({ id: g.principalId, name: '', email: g.principalLabel }, 'sm') : `<span class="tile tile-xs" aria-hidden="true">${icon('users', 'i-sm')}</span>`;
    return [
      `<div class="cell-user">${face}<div><strong>${esc(g.principalLabel)}</strong></div></div>`,
      badge(t(locale, g.principalType === 'user' ? 'instance.grants.user' : 'instance.grants.group'), { icon: g.principalType === 'user' ? 'user' : 'users' }),
      `<form method="post" action="${base}/grants" class="inline-form">${hiddenField('csrf', csrf)}${who}
<select name="level" aria-label="${esc(t(locale, 'instance.grants.levelOf', { name: g.principalLabel }))}">${optionList(grantLevels, g.level)}</select><button type="submit" class="${btn('secondary', true)}">${esc(t(locale, 'common.save'))}</button></form>`,
      form(`${base}/grants/remove`, csrf, hiddenField('type', g.principalType) + hiddenField('id', g.principalId), `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
    ];
  });
  const groups = core.groups.list().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  const list = rows.length
    ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'instance.grants.type'), t(locale, 'common.level'), ''], rows)
    : emptyState(t(locale, 'instance.grants.none'), 'share');
  const add = form(`${base}/grants`, csrf, `${field('grant-email', t(locale, 'instance.grants.email'), '<input id="grant-email" name="email" type="email" maxlength="254" autocomplete="off">')}
${field('grant-group', t(locale, 'instance.grants.orGroup'), `<select id="grant-group" name="group"><option value="">–</option>${groups}</select>`)}
${field('grant-level', t(locale, 'common.level'), `<select id="grant-level" name="level">${optionList(grantLevels, 'view')}</select>`)}`,
  `${icon('share')}${esc(t(locale, 'instance.grants.add'))}`, 'primary', 'form-row');
  return card(t(locale, 'instance.grants.title'), `${list}<div class="subsection">${add}</div>`);
}

/** Only shown to those who may attach domains. Lager cannot check who owns a DNS name, so the page says so. `base` is the add route. */
export function domainsBody(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const rows = core.domains.list(inst.id).map((host) => [
    `<a class="mono" href="${esc(hostUrl(core.config, host))}">${esc(host)}</a>`,
    form(`${base}/remove`, csrf, hiddenField('host', host), `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
  ]);
  const list = rows.length ? dataTable(locale, [t(locale, 'instance.domains.domain'), ''], rows) : emptyState(t(locale, 'instance.domains.none'), 'globe');
  const add = form(base, csrf, field('domain-host', t(locale, 'instance.domains.host'),
    '<input id="domain-host" name="host" required maxlength="253" autocomplete="off" spellcheck="false" placeholder="notes.example.com">'),
  `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row');
  return `${list}<div class="subsection">${add}<p class="hint gap-top">${esc(t(locale, 'instance.domains.hint'))}</p></div>`;
}

/** Destructive actions at the bottom of the main column: each confirmed by typing the name. */
function dangerZone(locale: Locale, title: string, text: string, action: string, csrf: string, name: string, submit: string): string {
  return `<section class="card card-danger"><h2>${icon('alert')}${esc(t(locale, 'common.dangerZone'))}</h2><div class="danger-row"><h3>${esc(title)}</h3><p>${esc(text)}</p>
${form(action, csrf, field('confirm', t(locale, 'instance.delete.confirm', { name }), `<input id="confirm" name="confirm" required autocomplete="off" spellcheck="false" data-confirm="${esc(name)}">`),
    `${icon('trash')}${esc(submit)}`, 'danger', 'stack')}</div></section>`;
}

const fact = (label: string, value: string): string => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const person = (u: User | null): string => (u
  ? `<div class="cell-user">${avatar(u, 'sm')}<div><strong>${esc(u.name || u.email)}</strong><span>${esc(u.email)}</span></div></div>` : '–');

/** Everything the instance uses against its quota: data, uploaded files and the versions it saved itself. */
const storageUsed = (core: Core, inst: Instance): number => core.data.usage(inst.id) + core.assets.usage(inst.id).bytes + core.apps.savedBytes(inst.id);

function instancePage(core: Core, locale: Locale, user: User, inst: Instance, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/instances/${encodeURIComponent(inst.slug)}`;
  const here = `/instances/${encodeURIComponent(inst.slug)}`;
  const app = core.apps.getApp(inst.appId)!;
  const url = instanceUrl(core.config, inst.slug);
  const title = t(locale, 'instance.pageTitle', { slug: inst.slug });
  const owner = core.access.canDeleteInstance(inst, user);
  const del = owner ? dangerZone(locale, t(locale, 'instance.delete.title'), t(locale, 'instance.delete.text'), `${base}/delete`, csrf, inst.slug, t(locale, 'instance.delete.submit')) : '';
  const visibility = badge(visibilityLabel(locale, inst.visibility), { icon: visibilityIcon(inst.visibility) });
  if (inst.disabled) {
    return shell(core, locale, user, title, `${hero(app, app.title, `<span class="url">${esc(url)}</span>`, [badge(t(locale, 'common.disabled'), { tone: 'danger', icon: 'alert' }), badge(`v${inst.activeVersion}`)], '')}
${notice('warning', t(locale, 'instance.disabledNotice'))}<div class="main-col">${del}</div>`, flash, here);
  }
  const snapshots = core.data.listSnapshots(inst.id);
  const mayRestore = core.access.canRestoreInstance(inst, user);
  const snapRows = snapshots.map((s) => [`<span class="mono">${esc(s.label)}</span>`, dateText(locale, s.createdAt), sizeText(locale, s.sizeBytes),
    mayRestore ? form(`${base}/restore`, csrf, hiddenField('snapshot', s.id), esc(t(locale, 'instance.snapshots.restore')), 'secondary', '', true) : '']);
  const level = inst.visibility === 'users'
    ? field('users-level', t(locale, 'instance.usersLevel'), `<select id="users-level" name="users_level">${optionList(levelOptions(locale, USERS_LEVELS), inst.usersLevel)}</select>`) : '';
  const quota = core.config.instanceQuotaBytes;
  const used = storageUsed(core, inst);
  const storage = quota > 0
    ? meter(used, quota, t(locale, 'instance.storage.used', { used: formatSize(locale, used), quota: formatSize(locale, quota) }))
    : `<p class="num">${sizeText(locale, used)}</p>`;
  const snapshotBytes = snapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
  const snapshotStorage = snapshotBytes > 0 ? `<p class="hint">${esc(t(locale, 'instance.storage.snapshots', { size: formatSize(locale, snapshotBytes) }))}</p>` : '';
  const details = `<section class="card"><h2>${esc(t(locale, 'instance.details'))}</h2><dl class="facts">
${fact(t(locale, 'common.owner'), person(core.users.get(inst.ownerId)))}
${fact(t(locale, 'instance.visibility.title'), form(`${base}/visibility`, csrf,
    `${field('visibility', t(locale, 'instance.visibility.who'), `<select id="visibility" name="visibility">${optionList(visibilityOptions(locale), inst.visibility)}</select>`)}${level}`,
    esc(t(locale, 'common.save')), 'secondary', 'stack', true))}
${fact(t(locale, 'instance.autoUpdate.title'), form(`${base}/auto-update`, csrf,
    `${hiddenField('on', '0')}<label class="check"><input type="checkbox" class="switch" name="on" value="1"${inst.autoUpdate ? ' checked' : ''}><span><strong>${esc(t(locale, 'instance.autoUpdate.label'))}</strong><span class="hint">${esc(t(locale, 'instance.autoUpdate.hint'))}</span></span></label>`,
    esc(t(locale, 'common.save')), 'secondary', 'stack', true))}
${core.settings.madeWithBadge ? fact(t(locale, 'instance.badge.title'), form(`${base}/badge`, csrf,
    `${hiddenField('on', '0')}<label class="check"><input type="checkbox" class="switch" name="on" value="1"${inst.showBadge ? ' checked' : ''}><span><strong>${esc(t(locale, 'instance.badge.label'))}</strong><span class="hint">${esc(t(locale, 'instance.badge.hint'))}</span></span></label>`,
    esc(t(locale, 'common.save')), 'secondary', 'stack', true)) : ''}
${fact(t(locale, 'instance.storage'), `${storage}${snapshotStorage}`)}</dl></section>`;
  const versions = `<section class="card"><div class="card-title"><h2>${esc(t(locale, 'instance.version'))}</h2>${badge(t(locale, 'instance.activeVersion', { number: inst.activeVersion }), { tone: 'success', dot: true })}</div>
${versionsList(core, locale, user, app, base, csrf, inst.activeVersion, inst.id)}</section>`;
  const data = `<section class="card"><h2>${esc(t(locale, 'instance.data.title'))}</h2>
<div class="btn-row"><a class="${btn('secondary', true)}" href="/instances/${encodeURIComponent(inst.slug)}/export">${icon('download')}${esc(t(locale, 'instance.data.export'))}</a></div>
<p class="hint gap-top">${esc(t(locale, 'instance.data.hint', { slug: inst.slug }))}</p>
<div class="subsection"><h3>${esc(t(locale, 'instance.snapshots.title'))}</h3>${snapshots.length
    ? `${dataTable(locale, [t(locale, 'common.name'), t(locale, 'common.date'), t(locale, 'common.size'), ''], snapRows)}${mayRestore ? '' : `<p class="hint gap-top">${esc(t(locale, 'instance.snapshots.ownerOnly'))}</p>`}`
    : emptyState(t(locale, 'instance.snapshots.none'), 'download')}</div></section>`;
  const domains = core.domains.canManage(user, core.access.canManageInstance(inst, user)) ? card(t(locale, 'instance.domains.title'), domainsBody(core, locale, inst, `${base}/domains`, csrf)) : '';
  return shell(core, locale, user, title, `${hero(app, app.title, `<a class="url" href="${esc(url)}">${esc(url)}</a>`, [visibility, badge(`v${inst.activeVersion}`)],
    linkButton(url, `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary'))}
<div class="layout"><div class="main-col">${versions}${grantsCard(core, locale, inst, base, csrf)}${domains}${data}${del}</div>
<aside class="side-col" aria-label="${esc(t(locale, 'instance.details'))}">${details}</aside></div>`, flash, here);
}

function appPage(core: Core, locale: Locale, user: User, app: App, flash: Flash): string {
  const csrf = csrfToken(core, user);
  const base = `/ui/apps/${encodeURIComponent(app.slug)}`;
  const saved = new Map<string, number>();
  for (const v of core.apps.listVersions(app.id)) if (v.instanceId !== null) saved.set(v.instanceId, (saved.get(v.instanceId) ?? 0) + 1);
  const instances = core.apps.listInstances(app.id);
  const rows = instances.map((i) => [
    `<a class="mono" href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a>`,
    esc(core.users.get(i.ownerId)?.email ?? '–'),
    saved.has(i.id) ? esc(t(locale, 'app.savedCount', { count: saved.get(i.id)! })) : '<span class="muted">–</span>',
    i.disabled ? badge(t(locale, 'common.disabled'), { tone: 'danger', icon: 'alert' })
      : core.access.canManageInstance(i, user) ? linkButton(`/instances/${encodeURIComponent(i.slug)}`, `${icon('settings')}${esc(t(locale, 'common.manage'))}`, 'quiet', true, named(t(locale, 'card.manage', { title: i.slug }))) : '',
  ]);
  const ownerField = core.access.canDeploy(app, user)
    ? field('owner-email', t(locale, 'app.ownerEmail'), '<input id="owner-email" name="owner_email" type="email" maxlength="254" autocomplete="off">') : '';
  const latest = core.apps.latestDeployedVersion(app.id)?.number ?? 0;
  const isOwner = core.access.isAppOwner(app, user);
  let collaborators = '';
  let selfService = '';
  let del = '';
  if (isOwner) {
    const collabRows = core.apps.listCollaborators(app.id).map((c) => [person(c), form(`${base}/collaborators/remove`, csrf, hiddenField('id', c.id), `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true)]);
    const selfModes: Option[] = [['off', t(locale, 'self.off')], ['users', t(locale, 'self.users')]];
    collaborators = card(t(locale, 'app.collaborators'), `${collabRows.length ? dataTable(locale, [t(locale, 'common.name'), ''], collabRows) : emptyState(t(locale, 'app.noCollaborators'), 'users')}
<div class="subsection">${form(`${base}/collaborators`, csrf, field('collab-email', t(locale, 'app.collaboratorEmail'), '<input id="collab-email" name="email" type="email" required maxlength="254" autocomplete="off">'),
    `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row')}</div>`);
    selfService = fact(t(locale, 'app.self.title'), form(`${base}/self-instances`, csrf,
      field('self-mode', t(locale, 'app.self.label'), `<select id="self-mode" name="mode">${optionList(selfModes, app.selfInstances)}</select>`), esc(t(locale, 'common.save')), 'secondary', 'stack', true));
    del = dangerZone(locale, t(locale, 'app.delete.title'), t(locale, 'app.delete.text'), `${base}/delete`, csrf, app.slug, t(locale, 'app.delete.submit'));
  }
  const details = `<section class="card"><h2>${esc(t(locale, 'instance.details'))}</h2><dl class="facts">${fact(t(locale, 'common.owner'), person(core.users.get(app.ownerId)))}${selfService}${modelFact(core, locale, user, app, base, csrf)}</dl></section>`;
  const count = instances.length;
  return shell(core, locale, user, t(locale, 'app.pageTitle', { title: app.title }), `${hero(app, app.title, `<span class="url">${esc(app.slug)}</span>`,
    [`<span class="badge"><span class="sr-only">${esc(t(locale, 'dash.latestVersion'))} </span>v${latest}</span>`, badge(t(locale, count === 1 ? 'dash.instanceCount.one' : 'dash.instanceCount.other', { count }), { icon: 'grid' })], '', app.description)}
<div class="layout"><div class="main-col">
<section class="card"><h2>${esc(t(locale, 'app.versions'))}</h2>${versionsList(core, locale, user, app, null, csrf)}</section>
<section class="card"><h2>${esc(t(locale, 'app.instances'))}</h2>${rows.length ? dataTable(locale, [t(locale, 'common.instance'), t(locale, 'common.owner'), t(locale, 'app.saved'), ''], rows) : emptyState(t(locale, 'app.noInstances'))}
<div class="subsection"><h3>${esc(t(locale, 'app.newInstance'))}</h3>${form(`${base}/instances`, csrf,
    `${field('new-slug', t(locale, 'instance.slugLabel'), `<input id="new-slug" name="slug" required maxlength="${MAX_SLUG_LENGTH}" autocomplete="off" spellcheck="false">`)}${ownerField}`,
    `${icon('plus')}${esc(t(locale, 'app.newInstance'))}`, 'primary', 'form-row')}</div></section>
${collaborators}${del}</div><aside class="side-col" aria-label="${esc(t(locale, 'instance.details'))}">${details}</aside></div>`, flash, `/apps/${encodeURIComponent(app.slug)}`, 'publish');
}

/**
 * The language model of an app that calls lager.complete, for those who deploy it: the models their own AI group allows,
 * plus the current choice even when it is not open to them, so saving the form unchanged never changes it.
 */
function modelFact(core: Core, locale: Locale, user: User, app: App, base: string, csrf: string): string {
  const latest = core.apps.latestDeployedVersion(app.id);
  const usesModel = latest !== null && latest.capabilities.complete !== null && typeof latest.capabilities.complete === 'object';
  if (!core.access.canDeploy(app, user) || (!usesModel && app.aiModelId === null)) return '';
  const declared = declaredModel(core, app);
  const allowed = core.ai.allowedModelsFor(user.id);
  const choices: Option[] = [['', declared ? t(locale, 'app.model.declared', { model: declared }) : t(locale, 'app.model.viewerDefault')],
    ...allowed.map((m): Option => [m.id, m.description ? `${m.id} – ${m.description}` : m.id])];
  if (app.aiModelId && !allowed.some((m) => m.id === app.aiModelId)) choices.push([app.aiModelId, t(locale, 'app.model.unavailable', { model: app.aiModelId })]);
  return fact(t(locale, 'app.model.title'), form(`${base}/model`, csrf,
    field('app-model', t(locale, 'app.model.label'), `<select id="app-model" name="model">${optionList(choices, app.aiModelId ?? '')}</select>`)
      + `<p class="hint">${esc(t(locale, 'app.model.hint'))}</p>`, esc(t(locale, 'common.save')), 'secondary', 'stack', true));
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
    const inst = managed(user, param(req, 'slug'));
    // Re-activating the active version changes nothing and takes no snapshot, so it costs no budget.
    if (version !== inst.activeVersion) countSnapshotAction(core, inst.id);
    core.apps.activate(inst.id, version, user.id);
  }));

  router.post('/ui/instances/:slug/auto-update', ...action(instBack, (req, user) => {
    // The form sends a hidden "0" and, when ticked, a "1" as well.
    const raw = (req.body as Record<string, unknown> | undefined)?.on;
    const on = Array.isArray(raw) ? raw.includes('1') : raw === '1';
    core.apps.setAutoUpdate(managed(user, param(req, 'slug')).id, on, user.id);
  }));

  router.post('/ui/instances/:slug/badge', ...action(instBack, (req, user) => {
    // The form sends a hidden "0" and, when ticked, a "1" as well.
    const raw = (req.body as Record<string, unknown> | undefined)?.on;
    const on = Array.isArray(raw) ? raw.includes('1') : raw === '1';
    core.apps.setShowBadge(managed(user, param(req, 'slug')).id, on, user.id);
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
    const inst = managed(user, param(req, 'slug'));
    // A restore also rolls back what the app's rules keep from a manager (other people's private areas, owner-only paths).
    if (!core.access.canRestoreInstance(inst, user)) throw new LagerError('forbidden', 'Only the owner may do this.');
    countSnapshotAction(core, inst.id);
    core.data.restore(inst.id, field(req, 'snapshot'));
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
      core.apps.createInstance({ appId: app.id, slug: field(req, 'slug', 100).trim(), ownerId: owner.id, createdBy: user.id });
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

  router.post('/ui/apps/:slug/model', ...action(appBack, (req, user) => {
    setAppModel(core, user, appOf(param(req, 'slug')), field(req, 'model', 100) || null);
  }));

  router.post('/ui/apps/:slug/delete', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    if (field(req, 'confirm') !== app.slug) throw new Notice('notice.confirmName');
    core.apps.deleteApp(app.id, user.id);
    return '/';
  }));
};
