import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf, requestLocale } from './locale.js';
import { MAX_NAME } from '../platform/groups.js';
import type { CustomDomainsMode, RegistrationMode } from '../platform/settings.js';
import { AiError, DEFAULT_GROUP, DEFAULT_HOURLY_LIMIT, HOURLY_LIMIT_MAX, MAX_MODEL_DESCRIPTION, MAX_TOKENS_LIMIT, PRESETS, PROVIDER_IDS, TEST_PROMPT, type AiGroup, type AiGroupInput, type AiModel, type AiModelInput, type AiProvider, type AiProviderInput, type ProviderId } from '../platform/ai.js';
import type { OwnedPlan } from '../platform/account-removal.js';
import type { Instance } from '../platform/apps.js';
import type { Role, User } from '../platform/users.js';
import { requireUser, shellFor, type PlatformExtension } from './app.js';
import { loginLimiter } from './platform.js';
import { noticeText, backLink, dateText, esc, field, forbiddenAdminPage, form, formErrorPage, hiddenField, missingPage, optionList, page, sizeText, visibilityLabel, type Option } from './pages.js';
import { domainsBody } from './manage.js';
import { appTile, avatar, badge, btn, callout, dataTable, emptyState, icon, linkButton, named, notice, personCell, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid } from './session.js';

const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const ROLE_KEYS: Record<Role, MessageKey> = { admin: 'role.admin', publisher: 'role.publisher', user: 'role.user' };
const DOMAIN_KEYS: Record<CustomDomainsMode, MessageKey> = { admins: 'admin.domains.admins', publishers: 'admin.domains.publishers' };
const MODE_KEYS: Record<RegistrationMode, MessageKey> = { open: 'admin.mode.open', invite: 'admin.mode.invite', closed: 'admin.mode.closed' };
const SECTIONS: Array<[Section, MessageKey]> = [['users', 'admin.section.users'], ['invites', 'admin.section.invites'], ['groups', 'admin.section.groups'], ['settings', 'admin.section.settings'], ['ai', 'admin.section.ai'], ['apps', 'admin.section.apps']];
const MAX_FIELD = 300;
/** Product names stay as they are; only the two generic entries are words that need translating. */
const providerLabel = (locale: Locale, id: ProviderId): string =>
  id === 'ollama' ? t(locale, 'admin.ai.provider.ollama') : id === 'custom' ? t(locale, 'admin.ai.provider.custom') : PRESETS[id].label;

type Section = 'users' | 'invites' | 'groups' | 'settings' | 'ai' | 'apps';
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

const mono = (v: string): string => `<span class="mono">${esc(v)}</span>`;
const none = '<span class="muted">–</span>';

const STATUS_TONES = { disabled: 'danger', active: 'success', unverified: 'warning' } as const;

function usersSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const aiGroups: Option[] = [[DEFAULT_GROUP, t(locale, 'admin.ai.everyoneElse')], ...core.ai.listGroups().filter((g) => !g.isDefault).map((g): Option => [g.id, g.name])];
  const rows = core.users.list().map((u) => {
    const base = `/admin/users/${encodeURIComponent(u.id)}`;
    const state = u.disabled ? 'disabled' : u.verified ? 'active' : 'unverified';
    const status = t(locale, u.disabled ? 'common.disabled' : u.verified ? 'common.active' : 'common.unverified');
    return [
      personCell(u),
      `<form method="post" action="${base}/role" class="inline-form">${hiddenField('csrf', csrf)}<select name="role" aria-label="${esc(t(locale, 'admin.users.roleOf', { email: u.email }))}">${roleOptions(locale, u.role)}</select><button type="submit" class="${btn('secondary', true)}">${esc(t(locale, 'common.save'))}</button></form>`,
      `<form method="post" action="${base}/ai-group" class="inline-form">${hiddenField('csrf', csrf)}<select name="group" aria-label="${esc(t(locale, 'admin.users.aiGroupOf', { email: u.email }))}">${optionList(aiGroups, core.ai.groupIdOf(u.id))}</select><button type="submit" class="${btn('secondary', true)}">${esc(t(locale, 'common.save'))}</button></form>`,
      badge(status, { tone: STATUS_TONES[state], dot: true }),
      `<span class="num">${dateText(locale, u.createdAt)}</span>`,
      `<div class="btn-row">${form(`${base}/disabled`, csrf, hiddenField('disabled', u.disabled ? '0' : '1'), esc(t(locale, u.disabled ? 'common.activate' : 'common.deactivate')), 'quiet', '', true)}
${form(`${base}/reset-link`, csrf, '', esc(t(locale, 'admin.users.resetLink')), 'quiet', '', true)}
${u.disabled && u.id !== admin.id ? linkButton(`${base}/delete`, `${icon('trash')}${esc(t(locale, 'admin.users.delete'))}`, 'quiet', true, named(t(locale, 'admin.users.delete.of', { email: u.email }))) : ''}</div>`,
    ];
  });
  return shell(core, locale, admin, 'users', t(locale, 'admin.section.users'),
    dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.users.role'), t(locale, 'admin.users.aiGroup'), t(locale, 'common.status'), t(locale, 'common.created'), ''], rows, 'table-dense'), msg);
}

/** At most this many names of what an account owns are spelled out on the confirmation page; the counts are always complete. */
const MAX_OWNED_SHOWN = 50;

/**
 * The page between "Delete account" and the deletion: what goes with the account, what it owns, what becomes of that, and
 * the address to type. Null when the account does not exist.
 */
function deleteUserPage(core: Core, locale: Locale, admin: User, userId: string, msg?: Msg, answered: { owned?: string; transferTo?: string } = {}): string | null {
  const target = core.users.get(userId);
  if (!target) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/users/${encodeURIComponent(target.id)}/delete`;
  const { apps, instances } = core.removal.owned(target.id);
  const names = (slugs: string[]): string => slugs.slice(0, MAX_OWNED_SHOWN).map(mono).join(', ') + (slugs.length > MAX_OWNED_SHOWN ? ', …' : '');
  const group = (label: string, slugs: string[]): string =>
    slugs.length ? `<div><dt>${esc(label)} <span class="count">${slugs.length}</span></dt><dd>${names(slugs)}</dd></div>` : '';
  const owns = apps.length + instances.length === 0
    ? `<p class="hint">${esc(t(locale, 'admin.users.delete.ownsNothing'))}</p>`
    : `<h3>${esc(t(locale, 'admin.users.delete.owns'))}</h3><dl class="facts">${group(t(locale, 'admin.section.apps'), apps.map((a) => a.slug))}${group(t(locale, 'app.instances'), instances.map((i) => i.slug))}</dl>`;
  // The safe choice comes first and is preselected: handing over loses nothing. After a refusal the page comes back with what
  // was chosen and entered, so a second try does what the first one meant to do.
  const trash = answered.owned === 'delete';
  const choice = apps.length + instances.length === 0 ? '' : `<fieldset class="stack"><legend>${esc(t(locale, 'admin.users.delete.what'))}</legend>
<label class="check"><input type="radio" name="owned" value="transfer"${trash ? '' : ' checked'}><span>${esc(t(locale, 'admin.users.delete.transfer'))}</span></label>
${field('transfer-to', t(locale, 'admin.users.delete.transferEmail'), `<input id="transfer-to" name="transfer_to" type="email" maxlength="254" autocomplete="off" value="${esc(answered.transferTo ?? admin.email)}">`, t(locale, 'admin.users.delete.transferHint'))}
<label class="check"><input type="radio" name="owned" value="delete"${trash ? ' checked' : ''}><span>${esc(t(locale, 'admin.users.delete.trash'))}</span></label></fieldset>`;
  // Cancel is the first button and so the form's default: Enter in a field never deletes.
  const body = `<p>${esc(t(locale, 'admin.users.delete.text', { name: target.name, email: target.email }))}</p>
<div class="subsection">${owns}</div>
<div class="subsection"><form method="post" action="${esc(base)}" class="stack">${hiddenField('csrf', csrf)}${choice}
${field('confirm', t(locale, 'admin.users.delete.confirm', { email: target.email }), `<input id="confirm" name="confirm" required autocomplete="off" spellcheck="false" data-confirm="${esc(target.email)}">`)}
<div class="btn-row"><button type="submit" name="decision" value="cancel" formnovalidate class="${btn('secondary')}">${esc(t(locale, 'signin.cancel'))}</button>
<button type="submit" name="decision" value="delete" class="${btn('danger')}">${icon('trash')}${esc(t(locale, 'admin.users.delete.submit'))}</button></div></form></div>`;
  return shell(core, locale, admin, 'users', t(locale, 'admin.users.delete.pageTitle', { email: target.email }), body, msg, base,
    `<a class="back" href="/admin/users">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.section.users'))}</a>`);
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
    ? dataTable(locale, [t(locale, 'common.email'), t(locale, 'admin.invites.role'), t(locale, 'common.created'), t(locale, 'admin.invites.validUntil'), ''], rows)
    : emptyState(t(locale, 'admin.invites.none'), 'users');
  // With mail on, a link without an address proves no mailbox, so whoever uses it confirms theirs like any registration.
  const unbound = core.mailer.enabled ? `<p class="hint">${esc(t(locale, 'admin.invites.unbound'))}</p>` : '';
  return shell(core, locale, admin, 'invites', t(locale, 'admin.section.invites'), `${create}${unbound}<div class="subsection">${list}</div>`, msg);
}

function groupsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const groups = core.groups.list();
  const rows = groups.map((g) => [
    `<div class="cell-user"><span class="tile tile-xs" aria-hidden="true">${icon('users', 'i-sm')}</span><div><a href="/admin/groups/${encodeURIComponent(g.id)}"><strong title="${esc(g.name)}">${esc(g.name)}</strong></a></div></div>`,
    `<span class="num">${g.memberCount}</span>`,
  ]);
  const body = `${groups.length ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.groups.members')], rows) : emptyState(t(locale, 'admin.groups.none'), 'users')}
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
    personCell(m),
    form(`${base}/members/${encodeURIComponent(m.id)}/remove`, csrf, '', `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true),
  ]);
  const body = `${form(`${base}/rename`, csrf, field('group-name', t(locale, 'common.name'), `<input id="group-name" name="name" required maxlength="${MAX_NAME}" value="${esc(group.name)}" autocomplete="off">`), esc(t(locale, 'common.rename')), 'secondary', 'form-row')}
<div class="subsection"><h3>${esc(t(locale, 'admin.groups.members'))}</h3>
${members.length ? dataTable(locale, [t(locale, 'common.name'), ''], rows) : emptyState(t(locale, 'admin.groups.noMembers'), 'users')}
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
${settingRow('made-with-badge', t(locale, 'admin.settings.badge'), t(locale, 'admin.settings.badge.hint'),
    `<input type="hidden" name="madeWithBadge" value="0"><label class="check"><input id="made-with-badge" type="checkbox" class="switch" name="madeWithBadge" value="1"${core.settings.madeWithBadge ? ' checked' : ''}><span>${esc(t(locale, 'admin.settings.badge.label'))}</span></label>`)}
</div>`, esc(t(locale, 'common.save')), 'primary', 'stack settings-form');
  return shell(core, locale, admin, 'settings', t(locale, 'admin.section.settings'), body, msg);
}

const aiBack = (locale: Locale): string => `<a class="back" href="/admin/ai">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.ai.all'))}</a>`;
const aiGroupName = (locale: Locale, g: AiGroup): string => g.isDefault ? t(locale, 'admin.ai.everyoneElse') : g.name;

/** Name, type, key and address of a provider; `p` fills the edit form. */
function providerFields(locale: Locale, p?: AiProvider): string {
  const types: Option[] = PROVIDER_IDS.map((id): Option => [id, providerLabel(locale, id)]);
  return `<div>
${settingRow('ai-provider-name', t(locale, 'common.name'), t(locale, 'admin.ai.providerName.hint'),
    `<input id="ai-provider-name" name="name" required maxlength="${MAX_NAME}" autocomplete="off" value="${esc(p?.name ?? '')}">`)}
${settingRow('ai-provider', t(locale, 'admin.ai.provider'), t(locale, 'admin.ai.provider.hint'),
    `<select id="ai-provider" name="type">${optionList(types, p?.type ?? 'anthropic')}</select>`)}
${settingRow('ai-key', t(locale, 'admin.ai.key'), t(locale, 'admin.ai.key.hint'),
    `<input id="ai-key" name="apiKey" type="password" maxlength="1000" autocomplete="off" spellcheck="false">`,
    p?.keyHint ? `<p class="hint">${esc(t(locale, 'admin.ai.keySaved', { hint: p.keyHint }))}</p>` : '')}
${settingRow('ai-base-url', t(locale, 'admin.ai.baseUrl'), t(locale, 'admin.ai.baseUrl.hint'),
    `<input id="ai-base-url" name="baseUrl" type="url" maxlength="500" autocomplete="off" spellcheck="false" placeholder="https://…/v1" value="${esc(p?.baseUrl ?? '')}">`)}
</div>`;
}


/** Catalog name (only when adding), provider, the provider's model name and what the model is good for. */
function modelFields(core: Core, locale: Locale, m?: AiModel): string {
  const providers: Option[] = core.ai.listProviders().map((p): Option => [p.id, p.name]);
  const examples = (['anthropic', 'openai', 'openrouter', 'deepseek', 'ollama'] as const).map((id) => PRESETS[id].modelHint).join(', ');
  const name = m ? '' : settingRow('ai-model-name', t(locale, 'common.name'), t(locale, 'admin.ai.modelName.hint'),
    `<input id="ai-model-name" name="id" required maxlength="40" autocomplete="off" spellcheck="false">`);
  return `<div>${name}
${settingRow('ai-model-provider', t(locale, 'admin.ai.provider'), t(locale, 'admin.ai.provider.hint'),
    `<select id="ai-model-provider" name="provider">${optionList(providers, m?.providerId ?? '')}</select>`)}
${settingRow('ai-model', t(locale, 'admin.ai.model'), t(locale, 'admin.ai.model.hint', { examples }),
    `<input id="ai-model" name="model" required maxlength="200" autocomplete="off" spellcheck="false" value="${esc(m?.model ?? '')}">`)}
${settingRow('ai-model-description', t(locale, 'admin.ai.description'), t(locale, 'admin.ai.description.hint'),
    `<input id="ai-model-description" name="description" maxlength="${MAX_MODEL_DESCRIPTION}" autocomplete="off" value="${esc(m?.description ?? '')}">`)}
</div>`;
}

/** Name (not for Everyone else), default model or Off, further allowed models and hourly limit of an AI group. */
function groupFields(core: Core, locale: Locale, g?: AiGroup): string {
  const models = core.ai.listModels();
  const defaults: Option[] = [['', t(locale, 'admin.ai.off')], ...models.map((m): Option => [m.id, m.id])];
  const name = g?.isDefault ? '' : settingRow('ai-group-name', t(locale, 'common.name'), t(locale, 'admin.ai.groupName.hint'),
    `<input id="ai-group-name" name="name" required maxlength="${MAX_NAME}" autocomplete="off" value="${esc(g?.name ?? '')}">`);
  const checks = models.map((m) => `<label class="check"><input type="checkbox" name="allowed" value="${esc(m.id)}"${g?.allowed.includes(m.id) ? ' checked' : ''}><span class="mono">${esc(m.id)}</span></label>`).join('');
  return `<div>${name}
${settingRow('ai-group-model', t(locale, 'admin.ai.defaultModel'), t(locale, 'admin.ai.defaultModel.hint'),
    `<select id="ai-group-model" name="model">${optionList(defaults, g?.modelId ?? '')}</select>`)}
<div class="settings-row" role="group" aria-labelledby="ai-allowed"><div><span class="label" id="ai-allowed">${esc(t(locale, 'admin.ai.allowed'))}</span><p class="hint">${esc(t(locale, 'admin.ai.allowed.hint'))}</p></div>
<div class="stack">${checks || none}</div></div>
${settingRow('ai-hourly', t(locale, 'admin.ai.hourlyLimit'), t(locale, 'admin.ai.hourlyLimit.hint'),
    `<input id="ai-hourly" name="hourlyLimit" type="number" inputmode="numeric" min="1" max="${HOURLY_LIMIT_MAX}" step="1" required value="${g?.hourlyLimit ?? DEFAULT_HOURLY_LIMIT}">`)}
</div>`;
}

function aiSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const providers = core.ai.listProviders();
  const models = core.ai.listModels();
  const groups = core.ai.listGroups();
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  const status = core.ai.configured
    ? notice('success', t(locale, 'admin.ai.status.on'))
    : `<p class="hint">${esc(t(locale, 'admin.ai.status.off'))}</p>`;
  const providerRows = providers.map((p) => [
    `<a href="/admin/ai/providers/${encodeURIComponent(p.id)}"><strong>${esc(p.name)}</strong></a>`,
    esc(providerLabel(locale, p.type)),
    p.baseUrl ? mono(p.baseUrl) : none,
    p.keyHint ? mono(p.keyHint) : none,
  ]);
  const modelRows = models.map((m) => [
    `<a href="/admin/ai/models/${encodeURIComponent(m.id)}"><strong class="mono">${esc(m.id)}</strong></a>`,
    esc(nameOf.get(m.providerId) ?? '–'),
    mono(m.model),
    m.description ? esc(m.description) : none,
  ]);
  const groupRows = groups.map((g) => [
    `<a href="/admin/ai/groups/${encodeURIComponent(g.id)}"><strong>${esc(aiGroupName(locale, g))}</strong></a>`,
    g.modelId ? mono(g.modelId) : badge(t(locale, 'admin.ai.off')),
    g.modelId && g.allowed.length ? mono(g.allowed.join(', ')) : none,
    `<span class="num">${g.hourlyLimit}</span>`,
    `<span class="num">${g.isDefault ? '–' : g.memberCount}</span>`,
  ]);
  const body = `<p class="hint">${esc(t(locale, 'admin.ai.intro'))}</p>${status}
<div class="subsection"><h3>${esc(t(locale, 'admin.ai.providers'))}</h3>
${providers.length ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.ai.provider'), t(locale, 'admin.ai.baseUrl'), t(locale, 'admin.ai.key')], providerRows) : emptyState(t(locale, 'admin.ai.providers.none'))}
<div class="gap-top">${form('/admin/ai/providers', csrf, providerFields(locale), `${icon('plus')}${esc(t(locale, 'admin.ai.providers.add'))}`, 'secondary', 'stack settings-form')}</div></div>
<div class="subsection"><h3>${esc(t(locale, 'admin.ai.models'))}</h3><p class="hint">${esc(t(locale, 'admin.ai.models.hint'))}</p>
${models.length ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.ai.provider'), t(locale, 'admin.ai.model'), t(locale, 'admin.ai.description')], modelRows) : emptyState(t(locale, 'admin.ai.models.none'))}
${providers.length ? `<div class="gap-top">${form('/admin/ai/models', csrf, modelFields(core, locale), `${icon('plus')}${esc(t(locale, 'admin.ai.models.add'))}`, 'secondary', 'stack settings-form')}</div>` : ''}</div>
<div class="subsection"><h3>${esc(t(locale, 'admin.ai.groups'))}</h3><p class="hint">${esc(t(locale, 'admin.ai.groups.hint'))}</p>
${dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.ai.defaultModel'), t(locale, 'admin.ai.allowed'), t(locale, 'admin.ai.hourlyLimit'), t(locale, 'admin.ai.people')], groupRows)}
${models.length ? `<div class="gap-top">${form('/admin/ai/groups', csrf, groupFields(core, locale), `${icon('plus')}${esc(t(locale, 'admin.ai.groups.add'))}`, 'secondary', 'stack settings-form')}</div>` : ''}</div>
<div class="subsection">${form('/admin/ai/max-tokens', csrf, `<div>${settingRow('ai-max-tokens', t(locale, 'admin.ai.maxTokens'), t(locale, 'admin.ai.maxTokens.hint'),
    `<input id="ai-max-tokens" name="maxTokens" type="number" inputmode="numeric" min="1" max="${MAX_TOKENS_LIMIT}" step="1" required value="${core.ai.maxTokens}">`)}</div>`, esc(t(locale, 'common.save')), 'secondary', 'stack settings-form')}</div>
<p class="hint">${esc(t(locale, 'admin.ai.access'))}</p>`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.section.ai'), body, msg);
}

function aiProviderPage(core: Core, locale: Locale, admin: User, id: string, msg?: Msg): string | null {
  const p = core.ai.getProvider(id);
  if (!p) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/ai/providers/${encodeURIComponent(p.id)}`;
  const body = `${form(base, csrf, providerFields(locale, p), esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}
<div class="subsection btn-row">${form(`${base}/test`, csrf, '', esc(t(locale, 'admin.ai.test')), 'secondary')}
${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteProvider'))}`, 'danger')}</div>`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.providerPage', { name: p.name }), body, msg, base, aiBack(locale));
}

function aiModelPage(core: Core, locale: Locale, admin: User, id: string, msg?: Msg): string | null {
  const m = core.ai.getModel(id);
  if (!m) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/ai/models/${encodeURIComponent(m.id)}`;
  const body = `${form(base, csrf, modelFields(core, locale, m), esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}
<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteModel'))}`, 'danger')}</div>`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.modelPage', { name: m.id }), body, msg, base, aiBack(locale));
}

function aiGroupPage(core: Core, locale: Locale, admin: User, id: string, msg?: Msg): string | null {
  const g = core.ai.getGroup(id);
  if (!g) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/ai/groups/${encodeURIComponent(g.id)}`;
  const body = `${g.isDefault ? `<p class="hint">${esc(t(locale, 'admin.ai.groups.hint'))}</p>` : ''}${form(base, csrf, groupFields(core, locale, g), esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}
${g.isDefault ? '' : `<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteGroup'))}`, 'danger')}</div>`}`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.groupPage', { name: aiGroupName(locale, g) }), body, msg, base, aiBack(locale));
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
${rows.length ? dataTable(locale, [t(locale, 'common.instance'), t(locale, 'common.owner'), t(locale, 'common.version'), t(locale, 'common.visibility'), t(locale, 'admin.apps.data'), t(locale, 'common.status'), ''], rows) : emptyState(t(locale, 'app.noInstances'))}</section>`;
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
  return shell(core, locale, admin, 'apps', t(locale, 'admin.domains.pageTitle', { slug: inst.slug }), domainsBody(core, locale, inst, base, csrf), msg, base,
    `<a class="back" href="/admin/apps">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.section.apps'))}</a>`);
}

/** Platform administrators only: no session goes to /login, any other role gets a 403 page. */
export function requireAdmin(core: Core): RequestHandler {
  const auth = requireUser(core);
  return (req, res, next) => {
    auth(req, res, () => {
      if ((res.locals.user as User).role !== 'admin') {
        res.status(403).type('html').send(forbiddenAdminPage(requestLocale(core, req, res.locals.user as User), shellFor(core, req, res.locals.user as User)));
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
        send(res, 403, formErrorPage(localeOf(res), 'error.sessionExpired', backLink(localeOf(res), '/admin', t(localeOf(res), 'admin.back')), shellFor(core, req, user)));
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
  /** "Does not exist" inside the administration shell; `back` is where the link below the message leads. */
  const missing = (req: Request, res: Response, what: MessageKey, href: string, label: MessageKey): string =>
    missingPage(localeOf(res), what, backLink(localeOf(res), href, t(localeOf(res), label)), shellFor(core, req, adminOf(res)));
  const failWith = (res: Response, e: unknown, view: (msg: Msg) => string | null, messages: Partial<Record<string, MessageKey>> = {}): void => {
    if (!(e instanceof LagerError)) throw e;
    const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400;
    const locale = localeOf(res);
    const error = noticeText(locale, messages[e.code] ?? 'validation.generic');
    send(res, status, view({ error }) ?? missing(res.req, res, 'error.notFound.text', '/admin', 'admin.back'));
  };

  const showUsers = (res: Response): void => send(res, 200, usersSection(core, localeOf(res), adminOf(res)));
  router.get('/admin', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/users', noStore, admin, (_req, res) => { showUsers(res); });
  router.get('/admin/invites', noStore, admin, (_req, res) => { send(res, 200, invitesSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/groups', noStore, admin, (_req, res) => { send(res, 200, groupsSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/groups/:id', noStore, admin, (req, res) => {
    const html = groupPage(core, localeOf(res), adminOf(res), param(req, 'id'));
    if (html === null) send(res, 404, missing(req, res, 'admin.groups.missing', '/admin/groups', 'admin.groups.all'));
    else send(res, 200, html);
  });
  router.get('/admin/settings', noStore, admin, (_req, res) => { send(res, 200, settingsSection(core, localeOf(res), adminOf(res))); });
  router.get('/admin/ai', noStore, admin, (_req, res) => { send(res, 200, aiSection(core, localeOf(res), adminOf(res))); });
  for (const [kind, view] of [['providers', aiProviderPage], ['models', aiModelPage], ['groups', aiGroupPage]] as const) {
    router.get(`/admin/ai/${kind}/:id`, noStore, admin, (req, res) => {
      const html = view(core, localeOf(res), adminOf(res), param(req, 'id'));
      if (html === null) send(res, 404, missing(req, res, 'admin.ai.notFound', '/admin/ai', 'admin.ai.all'));
      else send(res, 200, html);
    });
  }
  router.get('/admin/apps', noStore, admin, (_req, res) => { send(res, 200, appsSection(core, localeOf(res), adminOf(res))); });

  const domainInstanceOf = (req: Request): Instance => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) throw new LagerError('not_found', 'Instance not found.');
    return inst;
  };
  const showDomains = (res: Response, inst: Instance, status = 200, msg?: Msg): void => send(res, status, domainsPage(core, localeOf(res), adminOf(res), inst, msg));
  router.get('/admin/instances/:slug/domains', noStore, admin, (req, res) => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) send(res, 404, missing(req, res, 'admin.instances.notFound', '/admin/apps', 'admin.section.apps'));
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
        if (!inst) send(res, 404, missing(req, res, 'admin.instances.notFound', '/admin/apps', 'admin.section.apps'));
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

  // Deleting an account: a page that says what goes with it, then the deletion itself. Not offered over REST or MCP.
  const DELETE_NOTICES: Record<string, MessageKey> = {
    delete_self: 'admin.users.delete.self', delete_active: 'admin.users.delete.active', transfer_target: 'admin.users.delete.target',
    transfer_target_role: 'admin.users.delete.targetRole', other_users_instances: 'admin.users.delete.othersInstances', owned_choice: 'admin.users.delete.choose',
    confirm: 'admin.users.delete.confirmWrong',
  };
  /** A refusal: on the confirmation page while the account can still be deleted, else on the list of users. */
  const deleteRefused = (res: Response, user: User, id: string, e: unknown, answered?: { owned?: string; transferTo?: string }): void => {
    if (!(e instanceof LagerError)) throw e;
    const locale = localeOf(res);
    const error = noticeText(locale, (e.reason !== undefined ? DELETE_NOTICES[e.reason] : undefined) ?? (e.code === 'not_found' ? 'admin.users.notFound' : 'validation.generic'));
    const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400;
    const stays = e.reason !== 'delete_self' && e.reason !== 'delete_active';
    send(res, status, (stays ? deleteUserPage(core, locale, user, id, { error }, answered) : null) ?? usersSection(core, locale, user, { error }));
  };

  router.get('/admin/users/:id/delete', noStore, admin, (req, res) => {
    const user = adminOf(res);
    const id = param(req, 'id');
    try {
      core.removal.removable(id, user);
      send(res, 200, deleteUserPage(core, localeOf(res), user, id) ?? usersSection(core, localeOf(res), user));
    } catch (e) { deleteRefused(res, user, id, e); }
  });

  router.post('/admin/users/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    if (field(req, 'decision') !== 'delete') { res.redirect('/admin/users'); return; }
    const choice = field(req, 'owned');
    // Only what the form offers comes back in a re-rendered page.
    const answered = { owned: choice === 'delete' || choice === 'transfer' ? choice : undefined, transferTo: (req.body as Record<string, unknown>).transfer_to === undefined ? undefined : field(req, 'transfer_to', 254) };
    try {
      const target = core.removal.removable(id, user);
      if (field(req, 'confirm', 254) !== target.email) throw new LagerError('invalid_argument', 'The confirmation does not match.', 'confirm');
      const { apps, instances } = core.removal.owned(id);
      let plan: OwnedPlan = { delete: true };
      if (apps.length + instances.length > 0 && choice !== 'delete') {
        if (choice !== 'transfer') throw new LagerError('invalid_argument', 'owned must be transfer or delete.', 'owned_choice');
        const to = core.users.getByEmail(field(req, 'transfer_to', 254));
        if (!to) throw new LagerError('invalid_argument', 'No such account.', 'transfer_target');
        plan = { transferTo: to.id };
      }
      const { cleanedUp } = core.removal.remove(id, user, plan);
      // A pause the address had collected at the sign-in page does not wait for the next account of that name.
      loginLimiter(core).succeed(target.email.trim().toLowerCase());
      const locale = localeOf(res);
      // The account is gone either way; files that could not be moved are the administrator's to look at, in the log.
      send(res, 200, usersSection(core, locale, user, cleanedUp
        ? { ok: t(locale, 'admin.users.delete.done', { email: target.email }) }
        : { error: t(locale, 'admin.users.delete.cleanupFailed', { email: target.email }) }));
    } catch (e) { deleteRefused(res, user, id, e, answered); }
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
      // The form sends a hidden "0" and, when ticked, a "1" as well; a request without the field leaves the setting as it is.
      const badge = (req.body as Record<string, unknown> | undefined)?.madeWithBadge;
      if (badge !== undefined) core.settings.setMadeWithBadge(Array.isArray(badge) ? badge.includes('1') : badge === '1');
      res.redirect('/admin/settings');
    } catch (e) { failWith(res, e, (m) => settingsSection(core, localeOf(res), user, m), { invalid_argument: 'admin.settings.invalid' }); }
  }));

  // --- language model ---

  const aiMessages = { conflict: 'admin.ai.nameTaken', invalid_argument: 'admin.ai.invalid', not_found: 'admin.ai.notFound', forbidden: 'admin.ai.defaultFixed' } as const;
  const int = (req: Request, name: string): number => { const raw = field(req, name).trim(); return /^\d+$/.test(raw) ? Number(raw) : NaN; };
  const providerInput = (req: Request): AiProviderInput => {
    const key = field(req, 'apiKey', 1000);
    return { name: field(req, 'name'), type: field(req, 'type') as ProviderId, baseUrl: field(req, 'baseUrl', 600), apiKey: key === '' ? undefined : key };
  };
  const modelInput = (req: Request): AiModelInput =>
    ({ id: field(req, 'id', 100).trim().toLowerCase(), providerId: field(req, 'provider'), model: field(req, 'model'), description: field(req, 'description', MAX_MODEL_DESCRIPTION + 100) });
  /** Every checked box of a field that may repeat. */
  const fields = (req: Request, name: string): string[] => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').slice(0, 200);
  };
  const groupInput = (req: Request): AiGroupInput =>
    ({ name: field(req, 'name'), modelId: field(req, 'model') || null, allowed: fields(req, 'allowed'), hourlyLimit: int(req, 'hourlyLimit') });
  /** A sub-page whose provider or group vanished falls back to the overview with the message. */
  const aiFail = (res: Response, user: User, e: unknown, page: (m: Msg) => string | null): void =>
    failWith(res, e, (m) => page(m) ?? aiSection(core, localeOf(res), user, m), aiMessages);

  router.post('/admin/ai/providers', ...action((req, res, user) => {
    try {
      core.ai.createProvider(providerInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/providers/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateProvider(id, providerInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiProviderPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/providers/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    const locale = localeOf(res);
    try {
      core.ai.deleteProvider(id);
      res.redirect('/admin/ai');
    } catch (e) {
      if (e instanceof LagerError && e.reason === 'ai_provider_in_use') {
        const models = core.ai.modelsUsing(id).map((m) => m.id).join(', ');
        send(res, 409, aiProviderPage(core, locale, user, id, { error: t(locale, 'admin.ai.providerInUse', { models }) }) ?? '');
        return;
      }
      aiFail(res, user, e, (m) => aiProviderPage(core, locale, user, id, m));
    }
  }));

  router.post('/admin/ai/providers/:id/test', ...action(async (req, res, user) => {
    const id = param(req, 'id');
    const locale = localeOf(res);
    try {
      const out = await core.ai.complete(core.ai.testRoute(id), [{ role: 'user', content: TEST_PROMPT }], { maxTokens: Math.min(core.ai.maxTokens, 2000) });
      const answer = out.text.trim().slice(0, 200) || '–';
      send(res, 200, aiProviderPage(core, locale, user, id, { ok: t(locale, 'admin.ai.testOk', { model: out.model, answer }) }) ?? '');
    } catch (e) {
      if (e instanceof AiError) {
        // The administrator sees what the provider said; app viewers never do.
        send(res, 200, aiProviderPage(core, locale, user, id, { error: t(locale, 'admin.ai.testFailed', { error: [e.message, e.detail].filter(Boolean).join(' ') }) }) ?? '');
        return;
      }
      aiFail(res, user, e, (m) => aiProviderPage(core, locale, user, id, m));
    }
  }));

  router.post('/admin/ai/models', ...action((req, res, user) => {
    try {
      core.ai.createModel(modelInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/models/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateModel(id, modelInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiModelPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/models/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    const locale = localeOf(res);
    try {
      core.ai.deleteModel(id);
      res.redirect('/admin/ai');
    } catch (e) {
      if (e instanceof LagerError && e.reason === 'ai_model_in_use') {
        const groups = core.ai.groupsDefaultingTo(id).map((g) => aiGroupName(locale, g)).join(', ');
        send(res, 409, aiModelPage(core, locale, user, id, { error: t(locale, 'admin.ai.modelInUse', { groups }) }) ?? '');
        return;
      }
      aiFail(res, user, e, (m) => aiModelPage(core, locale, user, id, m));
    }
  }));

  router.post('/admin/ai/groups', ...action((req, res, user) => {
    try {
      core.ai.createGroup(groupInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/groups/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateGroup(id, groupInput(req));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiGroupPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/groups/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.deleteGroup(id);
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiGroupPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/max-tokens', ...action((req, res, user) => {
    try {
      core.ai.setMaxTokens(int(req, 'maxTokens'));
      res.redirect('/admin/ai');
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/users/:id/ai-group', ...action((req, res, user) => {
    try {
      core.ai.assign(param(req, 'id'), field(req, 'group'));
      res.redirect('/admin/users');
    } catch (e) { failWith(res, e, (m) => usersSection(core, localeOf(res), user, m), { not_found: 'admin.ai.notFound' }); }
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
