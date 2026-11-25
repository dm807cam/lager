import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { hostUrl, instanceUrl, MAX_SLUG_LENGTH } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { withSnapshotBudget } from './snapshot-limit.js';
import { formatDate, formatSize, t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf } from './locale.js';
import type { App, Instance, SelfInstances, UsersLevel, Version, Visibility } from '../platform/apps.js';
import type { GrantLevel } from '../platform/access.js';
import { ingestEndpoints, type IngestEndpoint } from '../platform/ingest.js';
import { embedDeclared } from '../platform/embed.js';
import type { User } from '../platform/users.js';
import { sendVersionDownload, streamExport, versionParam } from './api.js';
import { requireUser, shellFor, type PlatformExtension } from './app.js';
import { declaredModel, downloadableVersion, setAppModel } from '../mcp/tools.js';
import {
  confirmAttrs, confirmed, questionPage, dateText, esc, field, forbiddenAppPage, forbiddenInstancePage, form, hiddenField, levelLabel, levelOptions, missingPage, optionList, type Option, page, type Question,
  sizeText, slugField, staleFormPage, visibilityLabel, visibilityOptions, withNotice,
} from './pages.js';
import { appTile, avatar, badge, btn, named, card, copyButton, copyField, dataTable, emptyState, icon, linkButton, meter, notice, personCell, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid, flashUrl, readFlash, type Flash, type Undo } from './session.js';

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
  creation_rate_others: 'notice.creationRateOthers',
  owner_limit_half: 'notice.ownerLimitHalf',
  snapshot_rate: 'notice.snapshotRate',
  slug_invalid: 'notice.slugInvalid',
  slug_reserved: 'notice.slugInvalid',
  collaborators_invalid: 'notice.collaboratorsInvalid',
  owner_in_charge: 'notice.ownerInCharge',
  model_not_allowed: 'notice.modelNotAllowed',
  origin_invalid: 'notice.originInvalid',
  origins_limit: 'notice.originsLimit',
  origin_lager: 'notice.originLager',
  origin_same_site: 'notice.originSameSite',
  embed_limit: 'notice.embedLimit',
  owner_full_access: 'notice.ownerFullAccess',
  host_invalid: 'notice.hostInvalid',
  host_taken: 'notice.hostTaken',
  host_unavailable: 'notice.hostUnavailable',
  domain_limit: 'notice.domainLimit',
};

/**
 * Where a refused form's message goes: the id of the control it is about, and what was typed into the form's text fields (by
 * control id), so the page comes back with the message at the field and the input still there.
 */
type FieldOf = (req: Request, error: MessageKey) => { field: string; values: Record<string, string> } | undefined;
const bodyText = (req: Request, name: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v.slice(0, 300) : '';
};
/** The message of a one-field form: at control `id`, with what was typed into body field `name`. */
// The error is part of the signature every field mapping shares; a one-field form puts any of them at its field.
const at = (id: string, name: string): FieldOf => (req, _error) => ({ field: id, values: { [id]: bodyText(req, name) } });
/** Refusals that are about what was typed into the name of a new instance; any other (a limit, the owner) is no field's. */
const NAME_ERRORS: ReadonlySet<MessageKey> = new Set(['notice.slugInvalid', 'notice.slugTaken', 'notice.slugRetired']);

/** What a form did: the notice for the next page, the values it names, the section it is shown above, and another page to go to. */
interface Done { ok: MessageKey; params?: Record<string, string>; anchor?: string; to?: string; undo?: Undo; copy?: string }
/** A form that needs a yes first: the question, asked on a page of its own when the form came without the answer. */
interface Ask { ask: Question }

/** What a change of visibility says: who can open the instance now. */
const VISIBILITY_DONE: Record<Visibility, MessageKey> = { private: 'notice.ok.private', users: 'notice.ok.users', public: 'notice.ok.public' };

/** A message for the user that is not a domain error (unknown address, wrong confirmation); carries a catalog key. */
class Notice extends Error {
  constructor(public key: MessageKey) { super(key); }
}

/** Instance pages belong to "Apps", app pages to "Publish"; the back link leads there. */
function shell(core: Core, locale: Locale, user: User, title: string, body: string, flash: Flash, returnPath: string, section: 'apps' | 'publish' = 'apps'): string {
  const back = section === 'publish' && (user.role === 'admin' || user.role === 'publisher')
    ? backTo('/publish', t(locale, 'nav.publish')) : backTo('/', t(locale, 'common.backToOverview'));
  return page(locale, title, `${back}${withNotice(locale, flash, body, csrfToken(core, user))}`, signedIn(core, user, section, returnPath));
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
  const latest = core.apps.latestDeployedVersion(app.id)?.number;
  const items = [...shown].reverse().map((v) => {
    const isActive = v.number === active;
    const note = v.instanceId !== null ? badge(t(locale, 'instance.savedBySelf'), { icon: 'user' }) : '';
    const download = mayDownload(v)
      ? linkButton(`/apps/${encodeURIComponent(app.slug)}/versions/${v.number}/html`, `${icon('download')}${esc(t(locale, 'instance.downloadHtml'))}`, 'quiet', true) : '';
    const activate = base === null || isActive ? '' : form(`${base}/activate`, csrf, hiddenField('version', String(v.number)), esc(t(locale, 'common.activate')), 'secondary', '', true);
    return `<li data-version="${v.number}"${isActive ? ' class="is-active"' : ''}><span class="dot" aria-hidden="true"></span>
<div class="tl-body"><div class="tl-title"><strong>v${v.number}</strong>${isActive ? badge(t(locale, 'common.active'), { tone: 'success', dot: true }) : ''}${v.number === latest && v.instanceId === null ? badge(t(locale, 'instance.latest')) : ''}${note}</div>
<span class="tl-meta">${dateText(locale, v.createdAt)} · ${sizeText(locale, v.sizeBytes)}</span>${v.instanceId === null && v.note ? `<span class="tl-note">${esc(v.note)}</span>` : ''}</div>
<div class="tl-actions">${download}${activate}</div></li>`;
  }).join('');
  return `<ol class="timeline">${items}</ol>`;
}

/**
 * Who may open the instance, in one place: first who may open it at all (private, everyone signed in, public) and at which level,
 * then the people and groups it is shared with.
 */
function grantsCard(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const grantLevels = levelOptions(locale, GRANT_LEVELS);
  const level = inst.visibility === 'users'
    ? field('users-level', t(locale, 'instance.usersLevel'), `<select id="users-level" name="users_level">${optionList(levelOptions(locale, USERS_LEVELS), inst.usersLevel)}</select>`) : '';
  const visibility = form(`${base}/visibility`, csrf,
    `${field('visibility', t(locale, 'instance.visibility.who'), `<select id="visibility" name="visibility">${optionList(visibilityOptions(locale), inst.visibility)}</select>`)}${level}`,
    esc(t(locale, 'common.save')), 'secondary', 'form-row');
  const rows = core.access.listGrants(inst.id).map((g) => {
    const who = g.principalType === 'user' ? hiddenField('email', g.principalLabel) : hiddenField('group', g.principalId);
    const face = g.principalType === 'user' ? avatar({ id: g.principalId, name: '', email: g.principalLabel }, 'sm') : `<span class="tile tile-xs" aria-hidden="true">${icon('users', 'i-sm')}</span>`;
    return [
      `<div class="cell-user">${face}<div><strong title="${esc(g.principalLabel)}">${esc(g.principalLabel)}</strong></div></div>`,
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
  // A person and a group are two forms: one of two fields that silently wins over the other cannot happen.
  const person = form(`${base}/grants`, csrf, `${field('grant-email', t(locale, 'instance.grants.email'), '<input id="grant-email" name="email" type="email" maxlength="254" autocomplete="off">')}
${field('grant-level', t(locale, 'common.level'), `<select id="grant-level" name="level">${optionList(grantLevels, 'view')}</select>`)}`,
  `${icon('share')}${esc(t(locale, 'instance.grants.add'))}`, 'primary', 'form-row');
  const group = groups ? form(`${base}/grants`, csrf, `${field('grant-group', t(locale, 'instance.grants.groupLabel'), `<select id="grant-group" name="group" required><option value="">–</option>${groups}</select>`)}
${field('grant-group-level', t(locale, 'common.level'), `<select id="grant-group-level" name="level">${optionList(grantLevels, 'view')}</select>`)}`,
  `${icon('share')}${esc(t(locale, 'instance.grants.add'))}`, 'secondary', 'form-row') : '';
  const add = `<h4>${esc(t(locale, 'instance.grants.person'))}</h4>${person}${group ? `<h4 class="gap-top">${esc(t(locale, 'instance.grants.withGroup'))}</h4>${group}` : ''}`;
  return card(t(locale, 'instance.grants.title'), `${visibility}<div class="subsection"><h3>${esc(t(locale, 'instance.grants.people'))}</h3>${list}<div class="gap-top">${add}</div></div>`, '', 'sharing');
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

/** The endpoints the active version of the instance declares. */
const endpointsOf = (core: Core, inst: Instance): IngestEndpoint[] =>
  ingestEndpoints(core.apps.getVersion(inst.appId, inst.activeVersion)?.capabilities);

/**
 * Where the instance takes data from outside, for the people who manage it: the address of every endpoint, who may send there,
 * its token, what came in since the server started, and the switch that closes it at once. Empty for an app without endpoints.
 */
function ingestCard(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const endpoints = endpointsOf(core, inst);
  if (endpoints.length === 0) return '';
  const title = t(locale, 'instance.ingest.title');
  if (!core.ingest.enabled) return card(title, `<p class="hint">${esc(t(locale, 'instance.ingest.serverOff'))}</p>`, '', 'ingest');
  const url = instanceUrl(core.config, inst.slug);
  const since = formatDate(locale, core.ingest.since, true);
  const items = endpoints.map((e) => {
    const off = core.ingest.isOff(inst.id, e.name);
    const counts = core.ingest.countsOf(inst.id, e.name);
    // Each website on its own, as text to read: the page loads nothing from there.
    const origins = core.ingest.originsFor(inst.id, e);
    const who = e.auth === 'token' ? esc(t(locale, 'instance.ingest.byToken'))
      : origins.length === 0 ? esc(t(locale, 'instance.ingest.noOrigins'))
        : `${esc(t(locale, 'instance.ingest.byOrigins'))} ${origins.map((o) => `<code>${esc(o)}</code>`).join(' ')}`;
    const name = hiddenField('name', e.name);
    const managed = e.managedOrigins ? managedOriginsBody(core, locale, inst, e, base, csrf) : '';
    const token = e.auth === 'token' ? `<div class="field"><span class="hint">${esc(t(locale, 'instance.ingest.token'))}</span>${copyField(locale, core.ingest.token(inst.id, e.name))}
<p class="hint">${esc(t(locale, 'instance.ingest.tokenHint'))}</p></div>` : '';
    return `<div class="subsection" data-endpoint="${esc(e.name)}"><div class="card-title"><h3 class="mono">${esc(e.name)}</h3>${off
      ? badge(t(locale, 'instance.ingest.off'), { tone: 'warning', icon: 'alert' }) : badge(t(locale, 'instance.ingest.on'), { tone: 'success', dot: true })}</div>
${copyField(locale, `${url}/_ingest/${e.name}`)}
<p class="hint">${who}</p><p class="hint">${esc(t(locale, 'instance.ingest.into', { collection: e.collection }))}</p>${token}
<p class="hint">${esc(t(locale, 'instance.ingest.counts', { accepted: counts.accepted, refused: counts.refused, limited: counts.limited, date: since }))}</p>
<div class="btn-row">${form(`${base}/ingest/switch`, csrf, name + hiddenField('on', off ? '1' : '0'), esc(t(locale, off ? 'instance.ingest.turnOn' : 'instance.ingest.turnOff')), 'secondary', '', true)}
${e.auth === 'token' ? form(`${base}/ingest/token`, csrf, name, esc(t(locale, 'instance.ingest.rotate')), 'quiet', '', true, confirmAttrs(locale, rotateQuestion(locale, e.name))) : ''}</div>${managed}</div>`;
  }).join('');
  const used = core.data.ingestUsage(inst.id);
  return card(title, `<p class="hint">${esc(t(locale, 'instance.ingest.intro'))}</p>${items}
<div class="subsection">${meter(used, core.ingest.quotaBytes, t(locale, 'instance.ingest.storage', { used: formatSize(locale, used), quota: formatSize(locale, core.ingest.quotaBytes) }))}
<p class="hint gap-top">${esc(t(locale, 'instance.ingest.storageHint'))}</p></div>`, '', 'ingest');
}

/** The websites the people who manage the instance added to an endpoint with `managedOrigins`, each removable, and a form to add one. */
function managedOriginsBody(core: Core, locale: Locale, inst: Instance, e: IngestEndpoint, base: string, csrf: string): string {
  const name = hiddenField('name', e.name);
  const id = `origin-${e.name}`;
  const counted = core.ingest.originsFor(inst.id, e);
  const rows = core.ingest.instanceOrigins(inst.id, e.name).map((origin) => [
    `<span class="mono">${esc(origin)}</span>${counted.includes(origin) ? '' : ` ${badge(t(locale, 'instance.ingest.overLimit'), { tone: 'warning', icon: 'alert' })}`}`,
    form(`${base}/ingest/origins/remove`, csrf, name + hiddenField('origin', origin), `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
  ]);
  const list = rows.length ? dataTable(locale, [t(locale, 'instance.ingest.origin'), ''], rows) : emptyState(t(locale, 'instance.ingest.managedNone'), 'globe');
  const add = form(`${base}/ingest/origins`, csrf, name + field(id, t(locale, 'instance.ingest.origin'),
    `<input id="${esc(id)}" name="origin" type="url" required maxlength="300" autocomplete="off" spellcheck="false" placeholder="https://blog.example.com">`),
  `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row');
  return `<div class="gap-top"><h4>${esc(t(locale, 'instance.ingest.managed'))}</h4>${list}${add}<p class="hint gap-top">${esc(t(locale, 'instance.ingest.managedHint'))}</p></div>`;
}

/**
 * The websites outside Lager that may show the instance in a frame, for the people who manage it: each removable, one marked
 * when it is not in effect (it has become an address of this server), and a form to add one. Empty for an app that does not
 * declare `embed`.
 */
function embedCard(core: Core, locale: Locale, inst: Instance, base: string, csrf: string): string {
  const caps = core.apps.getVersion(inst.appId, inst.activeVersion)?.capabilities;
  if (!embedDeclared(caps)) return '';
  const active = core.embed.frameAncestors(inst.id, caps);
  const rows = core.embed.origins(inst.id).map((origin) => [
    `<span class="mono">${esc(origin)}</span>${active.includes(origin) ? '' : ` ${badge(t(locale, 'instance.embed.inactive'), { tone: 'warning', icon: 'alert' })}`}`,
    form(`${base}/embed/remove`, csrf, hiddenField('origin', origin), `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
  ]);
  const list = rows.length ? dataTable(locale, [t(locale, 'instance.embed.origin'), ''], rows) : emptyState(t(locale, 'instance.embed.none'), 'globe');
  const add = form(`${base}/embed`, csrf, field('embed-origin', t(locale, 'instance.embed.origin'),
    '<input id="embed-origin" name="origin" type="url" required maxlength="300" autocomplete="off" spellcheck="false" placeholder="https://blog.example.com">'),
  `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row');
  return card(t(locale, 'instance.embed.title'), `<p class="hint">${esc(t(locale, 'instance.embed.intro'))}</p>${list}
<div class="subsection">${add}<p class="hint gap-top">${esc(t(locale, 'instance.embed.hint'))}</p></div>`, '', 'embed');
}

/** The questions before restoring a snapshot and before replacing an endpoint's token: neither can be taken back. */
const restoreQuestion = (locale: Locale, slug: string, label: string): Question =>
  ({ title: t(locale, 'confirm.restore.title', { label }), text: t(locale, 'confirm.restore.text', { slug }), submit: t(locale, 'instance.snapshots.restore') });
const rotateQuestion = (locale: Locale, name: string): Question =>
  ({ title: t(locale, 'confirm.ingestToken.title', { name }), text: t(locale, 'confirm.ingestToken.text'), submit: t(locale, 'instance.ingest.rotate') });

/** Destructive actions at the bottom of the main column: each confirmed by typing the name. */
function dangerZone(locale: Locale, title: string, text: string, action: string, csrf: string, name: string, submit: string): string {
  return `<section class="card card-danger"><h2>${icon('alert')}${esc(t(locale, 'common.dangerZone'))}</h2><div class="danger-row"><h3>${esc(title)}</h3><p>${esc(text)}</p>
${form(action, csrf, field('confirm', t(locale, 'instance.delete.confirm', { name }), `<input id="confirm" name="confirm" required autocomplete="off" spellcheck="false" data-confirm="${esc(name)}">`),
    `${icon('trash')}${esc(submit)}`, 'danger', 'stack')}</div></section>`;
}

const fact = (label: string, value: string): string => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const person = (u: User | null): string => (u
  ? personCell(u, u.name || u.email) : '–');

/** Everything the instance uses against its quota: data, uploaded files and the versions it saved itself. */
export const storageUsed = (core: Core, inst: Instance): number => core.data.usage(inst.id) + core.assets.usage(inst.id).bytes + core.apps.savedBytes(inst.id);

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
    mayRestore ? form(`${base}/restore`, csrf, hiddenField('snapshot', s.id), esc(t(locale, 'instance.snapshots.restore')), 'secondary', '', true,
      confirmAttrs(locale, restoreQuestion(locale, inst.slug, s.label))) : '']);
  const quota = core.quotas.of(inst.id);
  const used = storageUsed(core, inst);
  const storage = quota > 0
    ? meter(used, quota, t(locale, 'instance.storage.used', { used: formatSize(locale, used), quota: formatSize(locale, quota) }))
    : `<p class="num">${sizeText(locale, used)}</p>`;
  const snapshotBytes = snapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
  const snapshotStorage = snapshotBytes > 0 ? `<p class="hint">${esc(t(locale, 'instance.storage.snapshots', { size: formatSize(locale, snapshotBytes) }))}</p>` : '';
  const details = `<section class="card" id="details"><h2>${esc(t(locale, 'instance.details'))}</h2><dl class="facts">
${fact(t(locale, 'common.owner'), person(core.users.get(inst.ownerId)))}
${fact(t(locale, 'instance.settings'), form(`${base}/settings`, csrf,
    // Both switches in one form with one Save: changing two and pressing one button keeps both.
    `${hiddenField('auto_update', '0')}<label class="check"><input type="checkbox" class="switch" name="auto_update" value="1"${inst.autoUpdate ? ' checked' : ''}><span><strong>${esc(t(locale, 'instance.autoUpdate.label'))}</strong><span class="hint">${esc(t(locale, 'instance.autoUpdate.hint'))}</span></span></label>
${core.settings.madeWithBadge ? `${hiddenField('badge', '0')}<label class="check"><input type="checkbox" class="switch" name="badge" value="1"${inst.showBadge ? ' checked' : ''}><span><strong>${esc(t(locale, 'instance.badge.label'))}</strong><span class="hint">${esc(t(locale, 'instance.badge.hint'))}</span></span></label>` : ''}`,
    esc(t(locale, 'common.save')), 'secondary', 'stack', true))}
${fact(t(locale, 'instance.storage'), `${storage}${snapshotStorage}`)}</dl></section>`;
  // A rolled-back instance with updates on goes forward again with the next deploy: the page says so where the versions are.
  const latest = core.apps.latestDeployedVersion(app.id)?.number ?? 0;
  const behind = inst.autoUpdate && latest > inst.activeVersion
    ? notice('warning', t(locale, 'instance.behind', { latest, active: inst.activeVersion })) : '';
  const versions = `<section class="card" id="versions"><div class="card-title"><h2>${esc(t(locale, 'instance.version'))}</h2>${badge(t(locale, 'instance.activeVersion', { number: inst.activeVersion }), { tone: 'success', dot: true })}</div>
${behind}${versionsList(core, locale, user, app, base, csrf, inst.activeVersion, inst.id)}</section>`;
  const data = `<section class="card" id="data"><h2>${esc(t(locale, 'instance.data.title'))}</h2>
<div class="btn-row"><a class="${btn('secondary', true)}" href="/instances/${encodeURIComponent(inst.slug)}/export">${icon('download')}${esc(t(locale, 'instance.data.export'))}</a></div>
<p class="hint gap-top">${esc(t(locale, 'instance.data.hint', { slug: inst.slug }))}</p>
<div class="subsection"><h3>${esc(t(locale, 'instance.snapshots.title'))}</h3>${snapshots.length
    ? `${dataTable(locale, [t(locale, 'common.name'), t(locale, 'common.date'), t(locale, 'common.size'), ''], snapRows)}${mayRestore ? '' : `<p class="hint gap-top">${esc(t(locale, 'instance.snapshots.ownerOnly'))}</p>`}`
    : emptyState(t(locale, 'instance.snapshots.none'), 'download')}</div></section>`;
  const domains = core.domains.canManage(user, core.access.canManageInstance(inst, user)) ? card(t(locale, 'instance.domains.title'), domainsBody(core, locale, inst, `${base}/domains`, csrf), '', 'domains') : '';
  return shell(core, locale, user, title, `${hero(app, app.title, `<a class="url" href="${esc(url)}">${esc(url)}</a>`, [visibility, badge(`v${inst.activeVersion}`)],
    linkButton(url, `${icon('open')}${esc(t(locale, 'common.open'))}`, 'primary') + copyButton(locale, url, 'secondary', t(locale, 'instance.copyLink'), false))}
<div class="layout"><div class="main-col">${versions}${grantsCard(core, locale, inst, base, csrf)}${ingestCard(core, locale, inst, base, csrf)}${embedCard(core, locale, inst, base, csrf)}${domains}${data}${del}</div>
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
    `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row')}</div>`, '', 'collaborators');
    selfService = fact(t(locale, 'app.self.title'), form(`${base}/self-instances`, csrf,
      field('self-mode', t(locale, 'app.self.label'), `<select id="self-mode" name="mode">${optionList(selfModes, app.selfInstances)}</select>`), esc(t(locale, 'common.save')), 'secondary', 'stack', true));
    del = dangerZone(locale, t(locale, 'app.delete.title'), t(locale, 'app.delete.text'), `${base}/delete`, csrf, app.slug, t(locale, 'app.delete.submit'));
  }
  const details = `<section class="card" id="details"><h2>${esc(t(locale, 'instance.details'))}</h2><dl class="facts">${fact(t(locale, 'common.owner'), person(core.users.get(app.ownerId)))}${selfService}${modelFact(core, locale, user, app, base, csrf)}</dl></section>`;
  const count = instances.length;
  return shell(core, locale, user, t(locale, 'app.pageTitle', { title: app.title }), `${hero(app, app.title, `<span class="url">${esc(app.slug)}</span>`,
    [`<span class="badge"><span class="sr-only">${esc(t(locale, 'dash.latestVersion'))} </span>v${latest}</span>`, badge(t(locale, count === 1 ? 'dash.instanceCount.one' : 'dash.instanceCount.other', { count }), { icon: 'grid' })], '', app.description)}
<div class="layout"><div class="main-col">
<section class="card" id="versions"><h2>${esc(t(locale, 'app.versions'))}</h2>${versionsList(core, locale, user, app, null, csrf)}</section>
<section class="card" id="instances"><h2>${esc(t(locale, 'app.instances'))}</h2>${rows.length ? dataTable(locale, [t(locale, 'common.instance'), t(locale, 'common.owner'), t(locale, 'app.saved'), ''], rows) : emptyState(t(locale, 'app.noInstances'))}
<div class="subsection"><h3>${esc(t(locale, 'app.newInstance'))}</h3>${form(`${base}/instances`, csrf,
    `${slugField(locale, 'new-slug', t(locale, 'common.name'), core.apps.suggestSlug(app, ownerField ? null : user.id) ?? '', instanceUrl(core.config, '__slug__'))}${ownerField}`,
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
  /** Error pages keep the navigation: the viewer is signed in on every route here. */
  const shellOf = (res: Response): ReturnType<typeof shellFor> => shellFor(core, res.req, userOf(res));
  const param = (req: Request, name: string): string => String(req.params[name]);
  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const send = (res: Response, status: number, body: string): void => { res.status(status).type('html').send(body); };
  const toPage = (res: Response, user: User, path: string, flash: Flash): void => { res.redirect(flashUrl(core, user, path, flash)); };

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
  /** The active account with this address; `missing` is the notice when there is none. */
  const accountByEmail = (email: string, missing: MessageKey = 'notice.noAccount'): User => {
    const found = core.users.getByEmail(email.trim());
    if (!found || found.disabled) throw new Notice(missing);
    return found;
  };

  /**
   * Session, then CSRF, then the action. `back` is the page the form came from; `run` says what it did (`Done`), which the page
   * shows above the section that changed, and may name another page to go to. Domain errors become a notice on `back`,
   * forbidden and unknown targets error pages.
   */
  const action = (back: (req: Request, user: User) => string, run: (req: Request, user: User) => Done | Ask, fieldOf?: FieldOf): RequestHandler[] => [
    noStore, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) { send(res, 403, staleFormPage(localeOf(res), back(req, user), shellOf(res))); return; }
      try {
        const done = run(req, user);
        if ('ask' in done) {
          // The form came without the answer: ask on a page of its own, which sends the same fields again with it.
          send(res, 200, questionPage(localeOf(res), done.ask, req, csrfToken(core, user), back(req, user), shellOf(res)));
          return;
        }
        toPage(res, user, done.to ?? back(req, user), { ok: done.ok, params: done.params, anchor: done.anchor, undo: done.undo, copy: done.copy });
      } catch (e) {
        if (e instanceof Notice) { toPage(res, user, back(req, user), { error: e.key, ...fieldOf?.(req, e.key) }); return; }
        if (!(e instanceof LagerError)) throw e;
        if (e.code === 'forbidden') send(res, 403, forbiddenInstancePage(localeOf(res), shellOf(res)));
        else if (e.code === 'not_found') send(res, 404, missingPage(localeOf(res), 'notice.missing', undefined, shellOf(res)));
        else {
          const key = NOTICES[e.reason ?? ''] ?? 'validation.generic';
          toPage(res, user, back(req, user), { error: key, ...fieldOf?.(req, key) });
        }
      }
    },
  ];

  // --- instance page ---

  router.get('/instances/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) { send(res, 404, missingPage(localeOf(res), 'notice.instanceMissing', undefined, shellOf(res))); return; }
    if (!core.access.canManageInstance(inst, user) && !core.access.canDeleteInstance(inst, user)) { send(res, 403, forbiddenInstancePage(localeOf(res), shellOf(res))); return; }
    send(res, 200, instancePage(core, localeOf(res), user, inst, readFlash(core, user, req.query.flash)));
  });

  router.get('/instances/:slug/export', noStore, auth, (req, res, next) => {
    const user = userOf(res);
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) { send(res, 404, missingPage(localeOf(res), 'notice.instanceMissing', undefined, shellOf(res))); return; }
    if (!core.access.canManageInstance(inst, user)) { send(res, 403, forbiddenInstancePage(localeOf(res), shellOf(res))); return; }
    streamExport(core, user, inst, res).catch(next);
  });

  router.get('/apps/:slug/versions/:number/html', noStore, auth, (req, res) => {
    const slug = param(req, 'slug');
    try {
      const number = versionParam(req.params.number);
      sendVersionDownload(res, slug, number, downloadableVersion(core, userOf(res), slug, number).html);
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'forbidden') send(res, 403, forbiddenAppPage(localeOf(res), shellOf(res)));
      else send(res, 404, missingPage(localeOf(res), 'notice.versionMissing', undefined, shellOf(res)));
    }
  });

  const instBack = (req: Request): string => `/instances/${encodeURIComponent(param(req, 'slug'))}`;

  router.post('/ui/instances/:slug/activate', ...action(instBack, (req, user) => {
    const version = Number(field(req, 'version'));
    if (!Number.isInteger(version)) throw new LagerError('invalid_argument', 'Invalid version.');
    const inst = managed(user, param(req, 'slug'));
    withSnapshotBudget(core, inst.id, () => core.apps.activate(inst.id, version, user.id));
    return { ok: 'notice.ok.activated', params: { version: String(version) }, anchor: 'versions' };
  }));

  router.post('/ui/instances/:slug/auto-update', ...action(instBack, (req, user) => {
    // The form sends a hidden "0" and, when ticked, a "1" as well.
    const raw = (req.body as Record<string, unknown> | undefined)?.on;
    const on = Array.isArray(raw) ? raw.includes('1') : raw === '1';
    const inst = managed(user, param(req, 'slug'));
    // Switching it on can move the instance to the latest version, which takes a snapshot like a manual activation.
    const now = on ? withSnapshotBudget(core, inst.id, () => core.apps.setAutoUpdate(inst.id, on, user.id)) : core.apps.setAutoUpdate(inst.id, on, user.id);
    if (!on) return { ok: 'notice.ok.autoUpdateOff', params: { version: String(now.activeVersion) }, anchor: 'details' };
    // An instance that was behind moved to the latest version right away: the notice says so, not "the next deploy".
    return now.activeVersion !== inst.activeVersion
      ? { ok: 'notice.ok.autoUpdateMoved', params: { version: String(now.activeVersion) }, anchor: 'details' }
      : { ok: 'notice.ok.autoUpdateOn', anchor: 'details' };
  }));

  // Updates and the badge in one form: each is changed only where its value differs, and the notice names what changed.
  router.post('/ui/instances/:slug/settings', ...action(instBack, (req, user) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    // Each switch sends a hidden "0" and, when on, a "1" as well.
    const on = (name: string): boolean => (Array.isArray(body[name]) ? (body[name] as unknown[]).includes('1') : body[name] === '1');
    const inst = managed(user, param(req, 'slug'));
    // A switch the form did not send is left as it is, the same for both.
    const auto = on('auto_update');
    const autoChanged = body.auto_update !== undefined && auto !== inst.autoUpdate;
    const badgeChanged = core.settings.madeWithBadge && body.badge !== undefined && on('badge') !== inst.showBadge;
    // The badge first: switching updates on can be refused (the snapshot budget, a version with other data rules), and the
    // badge change sent with it is kept all the same; the refusal is the notice then.
    if (badgeChanged) core.apps.setShowBadge(inst.id, on('badge'), user.id);
    let now = inst;
    if (autoChanged) {
      // Switching it on can move the instance to the latest version, which takes a snapshot like a manual activation.
      now = auto ? withSnapshotBudget(core, inst.id, () => core.apps.setAutoUpdate(inst.id, true, user.id)) : core.apps.setAutoUpdate(inst.id, false, user.id);
    }
    // Moving to another version is the change that matters most, also when the badge changed with it.
    if (now.activeVersion !== inst.activeVersion) return { ok: 'notice.ok.autoUpdateMoved', params: { version: String(now.activeVersion) }, anchor: 'details' };
    if (autoChanged && !badgeChanged) {
      return auto ? { ok: 'notice.ok.autoUpdateOn', anchor: 'details' } : { ok: 'notice.ok.autoUpdateOff', params: { version: String(now.activeVersion) }, anchor: 'details' };
    }
    if (badgeChanged && !autoChanged) return { ok: on('badge') ? 'notice.ok.badgeOn' : 'notice.ok.badgeOff', anchor: 'details' };
    return { ok: 'notice.ok.saved', anchor: 'details' };
  }));

  router.post('/ui/instances/:slug/badge', ...action(instBack, (req, user) => {
    // The form sends a hidden "0" and, when ticked, a "1" as well.
    const raw = (req.body as Record<string, unknown> | undefined)?.on;
    const on = Array.isArray(raw) ? raw.includes('1') : raw === '1';
    core.apps.setShowBadge(managed(user, param(req, 'slug')).id, on, user.id);
    return { ok: on ? 'notice.ok.badgeOn' : 'notice.ok.badgeOff', anchor: 'details' };
  }));

  router.post('/ui/instances/:slug/visibility', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const usersLevel = field(req, 'users_level');
    // Validate before storing either value, so a bad level does not leave a half-applied change.
    if (usersLevel !== '' && !(USERS_LEVELS as readonly string[]).includes(usersLevel)) throw new LagerError('invalid_argument', 'Invalid level.');
    const now = core.apps.setVisibility(inst.id, field(req, 'visibility') as Visibility, user.id);
    if (usersLevel !== '') core.apps.setUsersLevel(inst.id, usersLevel as UsersLevel, user.id);
    return { ok: VISIBILITY_DONE[now.visibility], params: { slug: inst.slug }, anchor: 'sharing' };
  }));

  router.post('/ui/instances/:slug/restore', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    // A restore also rolls back what the app's rules keep from a manager (other people's private areas, owner-only paths).
    if (!core.access.canRestoreInstance(inst, user)) throw new LagerError('forbidden', 'Only the owner may do this.');
    const id = field(req, 'snapshot');
    const snap = core.data.listSnapshots(inst.id).find((s) => s.id === id);
    const label = snap?.label ?? id;
    // A snapshot that does not exist is refused as before, without a question first.
    if (snap && !confirmed(req.body)) return { ask: restoreQuestion(localeOf(req.res!), inst.slug, label) };
    withSnapshotBudget(core, inst.id, () => core.data.restore(inst.id, id));
    return { ok: 'notice.ok.restored', params: { label }, anchor: 'data' };
  }));

  router.post('/ui/instances/:slug/grants', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const level = field(req, 'level') as GrantLevel;
    const email = field(req, 'email', 254).trim();
    const group = field(req, 'group');
    let name: string;
    if (email !== '' && group !== '') throw new Notice('notice.grantBoth');
    if (email !== '') {
      // Nobody without an account can be shared with; what to do next depends on whether anyone may register, and who may invite.
      const next: MessageKey = core.settings.registration === 'open' ? 'notice.noAccount.open'
        : user.role === 'admin' ? 'notice.noAccount.admin' : 'notice.noAccount.ask';
      const account = accountByEmail(email, next);
      core.access.setGrant(inst, 'user', account.id, level, user);
      name = account.email;
    } else if (group !== '') {
      core.access.setGrant(inst, 'group', group, level, user);
      name = core.groups.get(group)?.name ?? group;
    } else throw new Notice('notice.grantTarget');
    // The address to send to the people just added comes with the notice.
    return { ok: 'notice.ok.shared', params: { name, level: levelLabel(localeOf(req.res!), level) }, anchor: 'sharing', copy: instanceUrl(core.config, inst.slug) };
  // Refusals go to the address field, the field they are about; "pick one" is no field's. A post naming both a person and a
  // group (only a hand-made one can) is shown there too: a refusal from the group branch would need its own mapping.
  }, (req, error) => (error === 'notice.grantTarget' ? undefined : at('grant-email', 'email')(req, error))));

  router.post('/ui/instances/:slug/grants/remove', ...action(instBack, (req, user) => {
    const inst = managed(user, param(req, 'slug'));
    const type = field(req, 'type') as 'user' | 'group';
    const id = field(req, 'id');
    const grant = core.access.listGrants(inst.id).find((g) => g.principalType === type && g.principalId === id);
    core.access.removeGrant(inst, type, id, user);
    const undo: Undo | undefined = grant && {
      action: `/ui/instances/${encodeURIComponent(inst.slug)}/grants`,
      fields: grant.principalType === 'user' ? { email: grant.principalLabel, level: grant.level } : { group: grant.principalId, level: grant.level },
    };
    return { ok: 'notice.ok.unshared', params: { name: grant?.principalLabel ?? id }, anchor: 'sharing', undo };
  }));

  router.post('/ui/instances/:slug/domains', ...action(instBack, (req, user) => {
    const host = field(req, 'host', 300);
    core.domains.add(managed(user, param(req, 'slug')), host, user, true);
    return { ok: 'notice.ok.domainAdded', params: { host: host.trim().toLowerCase() }, anchor: 'domains' };
  }, at('domain-host', 'host')));

  router.post('/ui/instances/:slug/domains/remove', ...action(instBack, (req, user) => {
    const host = field(req, 'host', 300);
    const inst = managed(user, param(req, 'slug'));
    // Undo only for what this press removed: on a stale page it would bring back what someone else took away, or never existed.
    const removed = core.domains.remove(inst, host, user, true);
    return { ok: 'notice.ok.removed', params: { name: host }, anchor: 'domains', undo: removed ? { action: `/ui/instances/${encodeURIComponent(inst.slug)}/domains`, fields: { host } } : undefined };
  }));

  /** The instance, if `user` manages it and its active version declares the endpoint the form names. */
  const managedEndpoint = (req: Request, user: User): { inst: Instance; name: string; endpoint: IngestEndpoint } => {
    const inst = managed(user, param(req, 'slug'));
    const name = field(req, 'name', 100);
    const endpoint = endpointsOf(core, inst).find((e) => e.name === name);
    if (!endpoint) throw new LagerError('not_found', 'Endpoint not found.');
    return { inst, name, endpoint };
  };

  router.post('/ui/instances/:slug/ingest/switch', ...action(instBack, (req, user) => {
    const { inst, name } = managedEndpoint(req, user);
    const on = field(req, 'on') === '1';
    core.ingest.setOff(inst.id, name, !on);
    return { ok: on ? 'notice.ok.ingestOn' : 'notice.ok.ingestOff', params: { name }, anchor: 'ingest' };
  }));

  router.post('/ui/instances/:slug/ingest/token', ...action(instBack, (req, user) => {
    const { inst, name } = managedEndpoint(req, user);
    if (!confirmed(req.body)) return { ask: rotateQuestion(localeOf(req.res!), name) };
    core.ingest.rotateToken(inst.id, name);
    return { ok: 'notice.ok.ingestToken', params: { name }, anchor: 'ingest' };
  }));

  router.post('/ui/instances/:slug/ingest/origins', ...action(instBack, (req, user) => {
    const { inst, name, endpoint } = managedEndpoint(req, user);
    // People paste what the address bar shows; one trailing slash is the only thing taken off before the strict check.
    const origin = field(req, 'origin', 300).trim().replace(/\/$/, '');
    core.ingest.setOrigins(inst.id, endpoint, [...core.ingest.instanceOrigins(inst.id, name), origin]);
    return { ok: 'notice.ok.added', params: { name: origin }, anchor: 'ingest' };
  }, (req, error) => at(`origin-${bodyText(req, 'name')}`, 'origin')(req, error)));

  router.post('/ui/instances/:slug/ingest/origins/remove', ...action(instBack, (req, user) => {
    const { inst, name, endpoint } = managedEndpoint(req, user);
    const origin = field(req, 'origin', 300);
    const before = core.ingest.instanceOrigins(inst.id, name);
    core.ingest.setOrigins(inst.id, endpoint, before.filter((o) => o !== origin));
    const undo = before.includes(origin) ? { action: `/ui/instances/${encodeURIComponent(inst.slug)}/ingest/origins`, fields: { name, origin } } : undefined;
    return { ok: 'notice.ok.removed', params: { name: origin }, anchor: 'ingest', undo };
  }));

  /** The instance, if `user` manages it and its active version declares `embed`. */
  const embedInstance = (req: Request, user: User): Instance => {
    const inst = managed(user, param(req, 'slug'));
    if (!embedDeclared(core.apps.getVersion(inst.appId, inst.activeVersion)?.capabilities)) throw new LagerError('not_found', 'This app is not built to be shown on other websites.');
    return inst;
  };

  router.post('/ui/instances/:slug/embed', ...action(instBack, (req, user) => {
    const inst = embedInstance(req, user);
    // People paste what the address bar shows; one trailing slash is the only thing taken off before the strict check.
    const origin = field(req, 'origin', 300).trim().replace(/\/$/, '');
    core.embed.setOrigins(inst.id, [...core.embed.origins(inst.id), origin]);
    return { ok: 'notice.ok.added', params: { name: origin }, anchor: 'embed' };
  }, at('embed-origin', 'origin')));

  router.post('/ui/instances/:slug/embed/remove', ...action(instBack, (req, user) => {
    const inst = embedInstance(req, user);
    const origin = field(req, 'origin', 300);
    const before = core.embed.origins(inst.id);
    core.embed.setOrigins(inst.id, before.filter((o) => o !== origin));
    const undo = before.includes(origin) ? { action: `/ui/instances/${encodeURIComponent(inst.slug)}/embed`, fields: { origin } } : undefined;
    return { ok: 'notice.ok.removed', params: { name: origin }, anchor: 'embed', undo };
  }));

  router.post('/ui/instances/:slug/delete', ...action(instBack, (req, user) => {
    const inst = instanceOf(param(req, 'slug'));
    // Deleting stays with the owner, also while an administrator has disabled the instance.
    if (!core.access.canDeleteInstance(inst, user)) throw new LagerError('forbidden', 'Only the owner may do this.');
    if (field(req, 'confirm') !== inst.slug) throw new Notice('notice.confirmName');
    core.apps.deleteInstance(inst.id, user.id);
    return { ok: 'notice.ok.instanceDeleted', params: { slug: inst.slug }, to: '/' };
  }, at('confirm', 'confirm')));

  // --- app page ---

  router.get('/apps/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    const app = core.apps.getApp(param(req, 'slug'));
    if (!app) { send(res, 404, missingPage(localeOf(res), 'notice.appMissing', undefined, shellOf(res))); return; }
    if (!core.access.canReadApp(app, user)) { send(res, 403, forbiddenAppPage(localeOf(res), shellOf(res))); return; }
    send(res, 200, appPage(core, localeOf(res), user, app, readFlash(core, user, req.query.flash)));
  });

  const appBack = (req: Request): string => `/apps/${encodeURIComponent(param(req, 'slug'))}`;

  /** The catalog's "Get your own copy" forms; "home" is what they sent while the catalog was part of the home page. */
  const fromCatalog = (req: Request): boolean => ['catalog', 'home'].includes(field(req, 'from'));
  router.post('/ui/apps/:slug/instances', ...action(
    (req, user) => {
      const app = core.apps.getApp(param(req, 'slug'));
      if (fromCatalog(req)) return '/catalog';
      return app && core.access.canReadApp(app, user) ? appBack(req) : '/';
    },
    (req, user) => {
      const app = appOf(param(req, 'slug'));
      if (!core.access.canCreateInstance(app, user)) throw new LagerError('forbidden', 'You may not create an instance of this app.');
      const email = field(req, 'owner_email', 254).trim();
      // Only people who deploy this app may create instances for others; for everyone else the field is ignored.
      const owner = email !== '' && core.access.canDeploy(app, user) ? accountByEmail(email) : user;
      const created = core.apps.createInstance({ appId: app.id, slug: field(req, 'slug', 100).trim(), ownerId: owner.id, createdBy: user.id });
      // From the catalog the new copy shows among one's own on the home page; from the app page in its list of instances.
      // In the catalog it is "your copy"; the word instance belongs to the app page.
      return fromCatalog(req)
        ? { ok: 'notice.ok.copyCreated', params: { slug: created.slug }, anchor: 'mine', to: '/' }
        : { ok: 'notice.ok.instanceCreated', params: { slug: created.slug }, anchor: 'instances' };
    },
    // In the catalog each app's name field is its own; an unknown owner is the owner field's problem, a name that cannot be used the name's.
    (req, error) => {
      if (error !== 'notice.noAccount' && !NAME_ERRORS.has(error)) return undefined;
      if (fromCatalog(req)) return at(`new-${param(req, 'slug')}`, 'slug')(req, error);
      const values = { 'new-slug': bodyText(req, 'slug'), 'owner-email': bodyText(req, 'owner_email') };
      return { field: error === 'notice.noAccount' ? 'owner-email' : 'new-slug', values };
    },
  ));

  router.post('/ui/apps/:slug/collaborators', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    const account = accountByEmail(field(req, 'email', 254));
    core.apps.addCollaborator(app.id, account.id, user.id);
    return { ok: 'notice.ok.collaboratorAdded', params: { name: account.name || account.email }, anchor: 'collaborators' };
  }, at('collab-email', 'email')));

  router.post('/ui/apps/:slug/collaborators/remove', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    // Only someone who works on the app is named: any other account id must not be turned into a name here.
    const who = core.apps.listCollaborators(app.id).find((c) => c.id === field(req, 'id'));
    if (!who) throw new Notice('notice.missing');
    core.apps.removeCollaborator(app.id, who.id, user.id);
    return {
      ok: 'notice.ok.collaboratorRemoved', params: { name: who.name || who.email }, anchor: 'collaborators',
      undo: { action: `/ui/apps/${encodeURIComponent(app.slug)}/collaborators`, fields: { email: who.email } },
    };
  }));

  router.post('/ui/apps/:slug/self-instances', ...action(appBack, (req, user) => {
    core.apps.setSelfInstances(ownedApp(user, param(req, 'slug')).id, field(req, 'mode') as SelfInstances, user.id);
    return { ok: 'notice.ok.saved', anchor: 'details' };
  }));

  router.post('/ui/apps/:slug/model', ...action(appBack, (req, user) => {
    setAppModel(core, user, appOf(param(req, 'slug')), field(req, 'model', 100) || null);
    return { ok: 'notice.ok.saved', anchor: 'details' };
  }));

  router.post('/ui/apps/:slug/delete', ...action(appBack, (req, user) => {
    const app = ownedApp(user, param(req, 'slug'));
    if (field(req, 'confirm') !== app.slug) throw new Notice('notice.confirmName');
    core.apps.deleteApp(app.id, user.id);
    return { ok: 'notice.ok.appDeleted', params: { name: app.title }, to: '/' };
  }, at('confirm', 'confirm')));

  // Opening the address of a form (a reload of a page it answered with, a bookmark) leads to the page the form is on.
  router.get('/ui/*rest', (req, res, next) => {
    const [kind, slug] = req.path.split('/').filter(Boolean).slice(1);
    if (kind === 'instances' && slug) res.redirect(`/instances/${slug}`);
    else if (kind === 'apps' && slug) res.redirect(`/apps/${slug}`);
    else if (kind === 'tokens') res.redirect('/publish');
    else next();
  });
};
