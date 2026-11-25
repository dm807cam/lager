import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { formatDate, formatDay, formatSize, t, type Locale, type MessageKey } from '../i18n/index.js';
import { localeOf, requestLocale } from './locale.js';
import { MAX_NAME } from '../platform/groups.js';
import { MAX_QUOTA_MB } from '../platform/quotas.js';
import type { CustomDomainsMode, RegistrationMode } from '../platform/settings.js';
import { AiError, DEFAULT_GROUP, DEFAULT_HOURLY_LIMIT, HOURLY_LIMIT_MAX, MAX_MODEL_DESCRIPTION, MAX_TOKENS_LIMIT, PRESETS, PROVIDER_IDS, TEST_PROMPT, type AiGroup, type AiGroupInput, type AiModel, type AiModelInput, type AiProvider, type AiProviderInput, type ProviderId } from '../platform/ai.js';
import type { OwnedPlan } from '../platform/account-removal.js';
import type { Instance } from '../platform/apps.js';
import { defaultSender, MAX_SMTP_PASSWORD, SMTP_SECURITY, smtpErrorText, type SmtpSecurity } from '../platform/mail.js';
import type { Role, User } from '../platform/users.js';
import { requireUser, shellFor, type PlatformExtension } from './app.js';
import { loginLimiter } from './platform.js';
import { confirmAttrs, confirmed, questionPage, staleFormPage, withFieldError, noticeText, backLink, dateText, esc, field, forbiddenAdminPage, form, hiddenField, missingPage, optionList, page, sizeText, undoForm, visibilityLabel, type Option, type Question } from './pages.js';
import { domainsBody, storageUsed } from './manage.js';
import { appTile, avatar, badge, btn, callout, dataTable, emptyState, icon, namedAction, linkButton, named, notice, personCell, signedIn, visibilityIcon } from './ui.js';
import { csrfToken, csrfValid, flashUrl, readFlash, type Flash, type Undo } from './session.js';
import { RateLimiter } from './ratelimit.js';
import { codeRefusal } from './two-factor.js';
import { MAX_CODE_INPUT } from '../platform/two-factor.js';

const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const ROLE_KEYS: Record<Role, MessageKey> = { admin: 'role.admin', publisher: 'role.publisher', user: 'role.user' };
const DOMAIN_KEYS: Record<CustomDomainsMode, MessageKey> = { admins: 'admin.domains.admins', publishers: 'admin.domains.publishers' };
const SECURITY_KEYS: Record<SmtpSecurity, MessageKey> = { tls: 'admin.mail.security.tls', starttls: 'admin.mail.security.starttls', none: 'admin.mail.security.none' };
const MODE_KEYS: Record<RegistrationMode, MessageKey> = { open: 'admin.mode.open', invite: 'admin.mode.invite', closed: 'admin.mode.closed' };
const SECTIONS: Array<[Section, MessageKey]> = [['users', 'admin.section.users'], ['invites', 'admin.section.invites'], ['groups', 'admin.section.groups'], ['settings', 'admin.section.settings'], ['mail', 'admin.section.mail'], ['ai', 'admin.section.ai'], ['apps', 'admin.section.apps']];
const MAX_FIELD = 300;
/** Product names stay as they are; only the two generic entries are words that need translating. */
const providerLabel = (locale: Locale, id: ProviderId): string =>
  id === 'ollama' ? t(locale, 'admin.ai.provider.ollama') : id === 'custom' ? t(locale, 'admin.ai.provider.custom') : PRESETS[id].label;

type Section = 'users' | 'invites' | 'groups' | 'settings' | 'mail' | 'ai' | 'apps';
/** A note above the section; `once` carries a one-time link and is never stored. */
interface Msg { ok?: string; error?: string; once?: { title: string; link: string }; undo?: Undo; field?: FieldError }
/** The control a refusal is about, and what was typed into the form's text fields (by control id). */
interface FieldError { id: string; values: Record<string, string> }

const roleLabel = (locale: Locale, role: Role): string => t(locale, ROLE_KEYS[role]);
const options = <K extends string>(locale: Locale, keys: Record<K, MessageKey>): Option[] => (Object.keys(keys) as K[]).map((k) => [k, t(locale, keys[k])]);
const roleOptions = (locale: Locale, selected: Role): string => optionList(ROLES.map((r) => [r, roleLabel(locale, r)] as const), selected);

function shell(core: Core, locale: Locale, admin: User, active: Section, title: string, body: string, msg: Msg = {}, returnPath = `/admin/${active}`, back = ''): string {
  const nav = `<nav class="pills" aria-label="${esc(t(locale, 'admin.sections'))}">${SECTIONS.map(([id, key]) =>
    `<a href="/admin/${id}"${id === active ? ' aria-current="page"' : ''}>${esc(t(locale, key))}</a>`).join('')}</nav>`;
  const once = msg.once ? callout(locale, msg.once.title, msg.once.link, t(locale, 'admin.oneTime')) : '';
  // A refusal about one field is shown at that field, with what was typed.
  const atField = msg.error && msg.field ? withFieldError(body, msg.field.id, msg.error, msg.field.values) : null;
  return page(locale, t(locale, 'admin.pageTitle', { section: title }), `<div class="page-head"><h1>${esc(t(locale, 'nav.admin'))}</h1>${nav}</div>
${msg.ok ? notice('success', msg.ok, msg.undo ? undoForm(locale, msg.undo, csrfToken(core, admin)) : '') : ''}${msg.error && !atField ? notice('danger', msg.error) : ''}${once}${back}
<section class="card" aria-labelledby="admin-section"><h2 id="admin-section">${esc(title)}</h2>${atField ?? body}</section>`, signedIn(core, admin, 'admin', returnPath));
}

const mono = (v: string): string => `<span class="mono">${esc(v)}</span>`;

/** The questions before changes that cannot be taken back; the forms carry them for the script, the routes ask them without it. */
const QUESTIONS = {
  invite: (locale: Locale): Question => ({ title: t(locale, 'confirm.inviteRevoke.title'), text: t(locale, 'confirm.inviteRevoke.text'), submit: t(locale, 'common.revoke') }),
  /** Names what goes with the group: its members and the instances shared with it. */
  group: (locale: Locale, name: string, members: number, shares: number): Question => ({
    title: t(locale, 'confirm.groupDelete.title', { name }),
    text: `${t(locale, 'confirm.groupDelete.counts', {
      members: t(locale, members === 1 ? 'confirm.groupDelete.members.one' : 'confirm.groupDelete.members.other', { count: members }),
      instances: t(locale, shares === 1 ? 'confirm.groupDelete.instances.one' : 'confirm.groupDelete.instances.other', { count: shares }),
    })} ${t(locale, 'confirm.groupDelete.text')}`,
    submit: t(locale, 'admin.groups.delete'),
  }),
  mail: (locale: Locale): Question => ({ title: t(locale, 'confirm.mailRemove.title'), text: t(locale, 'confirm.mailRemove.text'), submit: t(locale, 'admin.mail.remove') }),
  provider: (locale: Locale, name: string): Question => ({ title: t(locale, 'confirm.providerDelete.title', { name }), text: t(locale, 'confirm.providerDelete.text'), submit: t(locale, 'admin.ai.deleteProvider') }),
  model: (locale: Locale, name: string): Question => ({ title: t(locale, 'confirm.modelDelete.title', { name }), text: t(locale, 'confirm.modelDelete.text'), submit: t(locale, 'admin.ai.deleteModel') }),
  aiGroup: (locale: Locale, name: string): Question => ({ title: t(locale, 'confirm.aiGroupDelete.title', { name }), text: t(locale, 'confirm.aiGroupDelete.text'), submit: t(locale, 'admin.ai.deleteGroup') }),
};
const none = '<span class="muted">–</span>';

const STATUS_TONES = { disabled: 'danger', active: 'success', unverified: 'warning' } as const;

/** Where an account's own page lives. */
const userPath = (id: string): string => `/admin/users/${encodeURIComponent(id)}`;
/** The way back from a page about one account (deleting it, turning off its second step) to that account's page. */
const backToUser = (u: User): string => `<a class="back" href="${esc(userPath(u.id))}">${icon('chevron', 'i-sm')}${esc(u.name || u.email)}</a>`;

/** The status badges of an account: active, deactivated or unconfirmed, and whether it uses two-step sign-in. */
function userBadges(core: Core, locale: Locale, u: User): string {
  const state = u.disabled ? 'disabled' : u.verified ? 'active' : 'unverified';
  const status = t(locale, u.disabled ? 'common.disabled' : u.verified ? 'common.active' : 'common.unverified');
  return `${badge(status, { tone: STATUS_TONES[state], dot: true })}${core.twoFactor.isEnabled(u.id) ? ` ${badge(t(locale, 'admin.users.twoFactorOn'), { icon: 'shield', tone: 'success' })}` : ''}`;
}

/**
 * The list of accounts: who, role, AI group, status and since when, and a link to each account's page where it is changed. The
 * cells hold text only, so the table fits next to the navigation on any screen; with a form in every cell it could not.
 */
function usersSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const groupName = new Map(core.ai.listGroups().map((g) => [g.id, aiGroupName(locale, g)]));
  const rows = core.users.list().map((u) => [
    personCell(u),
    esc(roleLabel(locale, u.role)),
    esc(groupName.get(core.ai.groupIdOf(u.id)) ?? t(locale, 'admin.ai.everyoneElse')),
    `<div class="badges">${userBadges(core, locale, u)}</div>`,
    `<time class="num nowrap" datetime="${esc(u.createdAt)}" data-local="day" title="${esc(formatDate(locale, u.createdAt, true))}">${esc(formatDay(locale, u.createdAt))}</time>`,
    linkButton(userPath(u.id), `${icon('settings')}${esc(t(locale, 'common.manage'))}`, 'quiet', true, named(t(locale, 'card.manage', { title: u.email }))),
  ]);
  return shell(core, locale, admin, 'users', t(locale, 'admin.section.users'),
    dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.users.role'), t(locale, 'admin.users.aiGroup'), t(locale, 'common.status'), t(locale, 'common.created'), ''], rows, 'table-dense'), msg);
}

/**
 * One account: its role and AI group, a reset link, two-step sign-in, deactivating and deleting. Each change comes back to this page.
 * Null when the account does not exist.
 */
function userPage(core: Core, locale: Locale, admin: User, userId: string, msg?: Msg): string | null {
  const u = core.users.get(userId);
  if (!u) return null;
  const csrf = csrfToken(core, admin);
  const base = userPath(u.id);
  const self = u.id === admin.id;
  const aiGroups: Option[] = [[DEFAULT_GROUP, t(locale, 'admin.ai.everyoneElse')], ...core.ai.listGroups().filter((g) => !g.isDefault).map((g): Option => [g.id, g.name])];
  const save = (what: string): string => `<button type="submit" class="${btn('secondary', true)}"${namedAction(locale, t(locale, 'common.save'), what)}>${esc(t(locale, 'common.save'))}</button>`;
  const inline = (action: string, control: string, what: string): string => `<form method="post" action="${esc(action)}" class="inline-form setting-form">${hiddenField('csrf', csrf)}${control}${save(what)}</form>`;
  const twoFactorOn = core.twoFactor.isEnabled(u.id);
  // The name is the card's heading; next to the avatar go the address and the status.
  const head = `<div class="account-head gap-bottom">${avatar(u, 'lg')}<div><p class="lede">${esc(u.email)}</p><div class="badges gap-top">${userBadges(core, locale, u)}</div></div></div>
${self ? `<p class="hint gap-bottom">${esc(t(locale, 'admin.users.self'))} <a href="/account">${esc(t(locale, 'nav.account'))}</a></p>` : ''}`;
  const access = `<div>
${settingRow('user-role', t(locale, 'admin.users.role'), t(locale, 'admin.users.role.hint'), inline(`${base}/role`, `<select id="user-role" name="role">${roleOptions(locale, u.role)}</select>`, t(locale, 'admin.users.role')))}
${settingRow('user-ai-group', t(locale, 'admin.users.aiGroup'), t(locale, 'admin.users.aiGroup.hint'), inline(`${base}/ai-group`, `<select id="user-ai-group" name="group">${optionList(aiGroups, core.ai.groupIdOf(u.id))}</select>`, t(locale, 'admin.users.aiGroup')))}
</div>`;
  const action = (label: string, hint: string, control: string): string =>
    `<div class="settings-row"><div><span class="label">${esc(label)}</span><p class="hint">${esc(hint)}</p></div><div>${control}</div></div>`;
  // One's own password and second step are changed on the account page, with the current password and a code.
  const signIn = self ? '' : `<div class="subsection"><h3>${esc(t(locale, 'admin.users.signIn'))}</h3>
${action(t(locale, 'admin.users.resetLink'), t(locale, 'admin.users.resetLink.hint'), form(`${base}/reset-link`, csrf, '', esc(t(locale, 'admin.users.resetLink')), 'secondary', '', true))}
${action(t(locale, 'account.twoFactor.title'), t(locale, twoFactorOn ? 'admin.users.twoFactor.onHint' : 'admin.users.twoFactor.offHint'),
    twoFactorOn ? linkButton(`${base}/two-factor/reset`, esc(t(locale, 'admin.users.twoFactorReset')), 'secondary', true) : '')}</div>`;
  const state = self ? '' : `<div class="subsection"><h3>${esc(t(locale, 'admin.users.access'))}</h3>
${action(t(locale, u.disabled ? 'common.activate' : 'common.deactivate'), t(locale, u.disabled ? 'admin.users.activate.hint' : 'admin.users.deactivate.hint'),
    form(`${base}/disabled`, csrf, hiddenField('disabled', u.disabled ? '0' : '1'), esc(t(locale, u.disabled ? 'common.activate' : 'common.deactivate')), 'secondary', '', true))}
${action(t(locale, 'admin.users.delete'), t(locale, u.disabled ? 'admin.users.delete.hint' : 'admin.users.delete.active'),
    u.disabled ? linkButton(`${base}/delete`, `${icon('trash')}${esc(t(locale, 'admin.users.delete'))}`, 'danger', true) : '')}</div>`;
  return shell(core, locale, admin, 'users', u.name || u.email, `${head}${access}${signIn}${state}`, msg, base,
    `<a class="back" href="/admin/users">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.section.users'))}</a>`);
}

/**
 * The question before another account's second step is turned off. The administrator confirms with their own password, and their
 * own code if they use two-step sign-in: an administrator session left open must not be enough to strip it from somebody else.
 */
function twoFactorResetPage(core: Core, locale: Locale, admin: User, target: User, msg?: Msg): string {
  const base = `/admin/users/${encodeURIComponent(target.id)}/two-factor/reset`;
  const code = core.twoFactor.isEnabled(admin.id)
    ? field('tf-admin-code', t(locale, 'account.twoFactor.codeLabel'), `<input id="tf-admin-code" name="code" required maxlength="${MAX_CODE_INPUT}" autocomplete="one-time-code" spellcheck="false" autocapitalize="off">`)
    : '';
  const body = `<p>${esc(t(locale, 'admin.users.twoFactorReset.text', { email: target.email }))}</p>
<form method="post" action="${esc(base)}" class="stack">${hiddenField('csrf', csrfToken(core, admin))}
${field('tf-admin-current', t(locale, 'admin.users.twoFactorReset.password'), '<input id="tf-admin-current" name="current" type="password" required autocomplete="current-password">')}
${code}<div class="btn-row"><a class="${btn('secondary')}" href="${esc(userPath(target.id))}">${esc(t(locale, 'signin.cancel'))}</a>
<button type="submit" class="${btn('danger')}">${esc(t(locale, 'admin.users.twoFactorReset'))}</button></div></form>`;
  return shell(core, locale, admin, 'users', t(locale, 'admin.users.twoFactorReset.pageTitle', { email: target.email }), body, msg, base, backToUser(target));
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
  return shell(core, locale, admin, 'users', t(locale, 'admin.users.delete.pageTitle', { email: target.email }), body, msg, base, backToUser(target));
}

function invitesSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const now = new Date().toISOString();
  const open = core.accounts.listInvites().filter((i) => !i.used && i.expiresAt > now);
  const rows = open.map((i) => [
    i.email ? esc(i.email) : `<span class="muted">${esc(t(locale, 'common.any'))}</span>`, badge(roleLabel(locale, i.role)),
    `<span class="num">${dateText(locale, i.createdAt)}</span>`, `<span class="num">${dateText(locale, i.expiresAt)}</span>`,
    form(`/admin/invites/${encodeURIComponent(i.id)}/revoke`, csrf, '', esc(t(locale, 'common.revoke')), 'danger', '', true, confirmAttrs(locale, QUESTIONS.invite(locale)),
      // An invitation without an address is told apart by its role and when it expires (in UTC, said so: the cell shows local time).
      namedAction(locale, t(locale, 'common.revoke'), `${i.email || t(locale, 'common.any')}, ${roleLabel(locale, i.role)}, ${formatDate(locale, i.expiresAt, true)}`)),
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
  const body = `${groups.length ? dataTable(locale, [t(locale, 'common.name'), t(locale, 'admin.groups.members')], rows) : emptyState(t(locale, 'admin.groups.none'), 'users', { detail: t(locale, 'admin.groups.none.detail') })}
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
    form(`${base}/members/${encodeURIComponent(m.id)}/remove`, csrf, '', `${icon('trash')}${esc(t(locale, 'common.remove'))}`, 'quiet', '', true, '', namedAction(locale, t(locale, 'common.remove'), m.name || m.email)),
  ]);
  const body = `${form(`${base}/rename`, csrf, field('group-name', t(locale, 'common.name'), `<input id="group-name" name="name" required maxlength="${MAX_NAME}" value="${esc(group.name)}" autocomplete="off">`), esc(t(locale, 'common.rename')), 'secondary', 'form-row')}
<div class="subsection"><h3>${esc(t(locale, 'admin.groups.members'))}</h3>
${members.length ? dataTable(locale, [t(locale, 'common.name'), ''], rows) : emptyState(t(locale, 'admin.groups.noMembers'), 'users')}
<div class="gap-top">${form(`${base}/members`, csrf, field('member-email', t(locale, 'admin.groups.memberEmail'), '<input id="member-email" name="email" type="email" required maxlength="254" autocomplete="off">'),
    `${icon('plus')}${esc(t(locale, 'common.add'))}`, 'secondary', 'form-row')}</div></div>
<div class="subsection"><h3>${esc(t(locale, 'admin.quota.title'))}</h3>
${form(`${base}/quota`, csrf, field('group-quota', t(locale, 'admin.quota.label'), quotaInput(core, 'group-quota', core.quotas.ofGroup(group.id))),
    esc(t(locale, 'common.save')), 'secondary', 'form-row')}
<p class="hint gap-top">${esc(t(locale, 'admin.quota.groupHint', { size: defaultQuotaText(core, locale) }))}</p></div>
<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.groups.delete'))}`, 'danger', '', false, confirmAttrs(locale, QUESTIONS.group(locale, group.name, members.length, core.groups.sharesOf(group.id))))}</div>`;
  return shell(core, locale, admin, 'groups', t(locale, 'admin.groups.pageTitle', { name: group.name }), body, msg, base,
    `<a class="back" href="/admin/groups">${icon('chevron', 'i-sm')}${esc(t(locale, 'admin.groups.all'))}</a>`);
}

const MIB = 1024 * 1024;
/** The server's storage per instance (LAGER_INSTANCE_QUOTA_MB) as text. */
const defaultQuotaText = (core: Core, locale: Locale): string => formatSize(locale, core.quotas.defaultBytes);
/** A field for the storage of a group or an app in MiB; empty follows the next rule, with the default as placeholder. */
const quotaInput = (core: Core, id: string, bytes: number | null, label = ''): string =>
  `<input id="${esc(id)}" name="quota" type="number" inputmode="numeric" min="1" max="${MAX_QUOTA_MB}" step="1" autocomplete="off"`
  + ` value="${bytes === null ? '' : Math.floor(bytes / MIB)}"${core.quotas.defaultBytes > 0 ? ` placeholder="${Math.floor(core.quotas.defaultBytes / MIB)}"` : ''}${label ? ` aria-label="${esc(label)}"` : ''}>`;
/** What an instance uses against its storage, and how much that is. */
const storageText = (core: Core, locale: Locale, instanceId: string, used: number): string => {
  const quota = core.quotas.resolve(instanceId);
  const text = quota.bytes > 0 ? esc(t(locale, 'instance.storage.used', { used: formatSize(locale, used), quota: formatSize(locale, quota.bytes) })) : sizeText(locale, used);
  // Why this instance has the storage it has: the app's setting wins even over a larger one of a group.
  const source = quota.source === 'app' ? t(locale, 'admin.apps.quotaFromApp')
    : quota.group ? t(locale, 'admin.apps.quotaFromGroup', { group: quota.group.name }) : '';
  return source ? `${text}<span class="hint quota-source">${esc(source)}</span>` : text;
};

/** One setting: label and help text on the left, the control on the right; `control` is trusted markup. */
const settingRow = (id: string, label: string, hint: string, control: string, extra = ''): string =>
  `<div class="settings-row"><div><label for="${esc(id)}">${esc(label)}</label><p class="hint">${esc(hint)}</p>${extra}</div><div>${control}</div></div>`;

function settingsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const body = form('/admin/settings', csrf, `<div>
${settingRow('registration', t(locale, 'admin.settings.registration'), t(locale, 'admin.settings.registration.hint'),
    `<select id="registration" name="registration">${optionList(options(locale, MODE_KEYS), core.settings.registration)}</select>`,
    core.mailer.enabled ? '' : `<p class="hint">${esc(t(locale, 'admin.settings.noMail'))} <a href="/admin/mail">${esc(t(locale, 'admin.settings.setUpMail'))}</a></p>`)}
${settingRow('max-instances', t(locale, 'admin.settings.maxInstances'), t(locale, 'admin.settings.maxInstances.hint'),
    `<input id="max-instances" name="maxInstances" type="number" inputmode="numeric" min="1" max="1000" step="1" required value="${core.settings.maxInstancesPerUser}">`)}
${settingRow('custom-domains', t(locale, 'admin.settings.customDomains'), t(locale, 'admin.settings.customDomains.hint'),
    `<select id="custom-domains" name="customDomains">${optionList(options(locale, DOMAIN_KEYS), core.settings.customDomains)}</select>`)}
${settingRow('made-with-badge', t(locale, 'admin.settings.badge'), t(locale, 'admin.settings.badge.hint'),
    `<input type="hidden" name="madeWithBadge" value="0"><label class="check"><input id="made-with-badge" type="checkbox" class="switch" name="madeWithBadge" value="1"${core.settings.madeWithBadge ? ' checked' : ''}><span>${esc(t(locale, 'admin.settings.badge.label'))}</span></label>`)}
</div>`, esc(t(locale, 'common.save')), 'primary', 'stack settings-form');
  return shell(core, locale, admin, 'settings', t(locale, 'admin.section.settings'), body, msg);
}

/**
 * The mail server: where it comes from, the form for the one saved here, and a test mail to the administrator. With LAGER_SMTP_URL
 * the configuration file is in charge, and the page only says so and offers the test.
 */
function mailSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const source = core.mailSource;
  const saved = core.mailSettings.get();
  const status = source === 'env'
    ? notice('success', t(locale, 'admin.mail.env'))
    : saved
      ? notice('success', t(locale, 'admin.mail.status.on', { host: saved.host }))
      : `<p class="hint">${esc(t(locale, 'admin.mail.status.off'))}</p>`;
  const unreadable = source === 'admin' && saved?.passwordUnreadable ? notice('warning', t(locale, 'admin.mail.passwordUnreadable')) : '';
  // Without required encryption the sign-in goes out in plain text whenever the server offers no STARTTLS, or someone strips the offer.
  const cleartext = source === 'admin' && saved?.security === 'none' && saved.user ? notice('warning', t(locale, 'admin.mail.cleartext')) : '';
  const test = source === 'none' ? '' : `<div class="subsection"><h3>${esc(t(locale, 'admin.mail.test'))}</h3><p class="hint">${esc(t(locale, 'admin.mail.test.hint', { email: admin.email }))}</p>
<div class="btn-row">${form('/admin/mail/test', csrf, '', `${icon('check')}${esc(t(locale, 'admin.mail.test'))}`, 'secondary')}
${source === 'admin' ? form('/admin/mail/delete', csrf, '', `${icon('trash')}${esc(t(locale, 'admin.mail.remove'))}`, 'danger', '', false, confirmAttrs(locale, QUESTIONS.mail(locale))) : ''}</div></div>`;
  if (source === 'env') return shell(core, locale, admin, 'mail', t(locale, 'admin.section.mail'), `<p class="hint">${esc(t(locale, 'admin.mail.intro'))}</p>${status}${test}`, msg);
  const from = defaultSender(core.config);
  const fields = `<div>
${settingRow('smtp-host', t(locale, 'admin.mail.host'), t(locale, 'admin.mail.host.hint'),
    `<input id="smtp-host" name="host" required maxlength="253" autocomplete="off" spellcheck="false" placeholder="smtp.example.com" value="${esc(saved?.host ?? '')}">`)}
${settingRow('smtp-security', t(locale, 'admin.mail.security'), t(locale, 'admin.mail.security.hint'),
    `<select id="smtp-security" name="security">${optionList(options(locale, SECURITY_KEYS), saved?.security ?? 'tls')}</select>`)}
${settingRow('smtp-port', t(locale, 'admin.mail.port'), t(locale, 'admin.mail.port.hint'),
    `<input id="smtp-port" name="port" type="number" inputmode="numeric" min="1" max="65535" step="1" value="${saved ? saved.port : ''}">`)}
${settingRow('smtp-user', t(locale, 'admin.mail.user'), t(locale, 'admin.mail.user.hint'),
    `<input id="smtp-user" name="user" maxlength="254" autocomplete="off" spellcheck="false" value="${esc(saved?.user ?? '')}">`)}
${settingRow('smtp-password', t(locale, 'admin.mail.password'), t(locale, 'admin.mail.password.hint'),
    `<input id="smtp-password" name="password" type="password" data-reveal="off" maxlength="${MAX_SMTP_PASSWORD}" autocomplete="new-password" spellcheck="false">`,
    saved?.passwordSaved && !saved.passwordUnreadable ? `<p class="hint">${esc(t(locale, 'admin.mail.passwordSaved'))}</p>` : '')}
${settingRow('smtp-from', t(locale, 'admin.mail.from'), t(locale, 'admin.mail.from.hint', { from }),
    `<input id="smtp-from" name="from" maxlength="200" autocomplete="off" spellcheck="false" placeholder="${esc(from)}" value="${esc(saved?.from ?? '')}">`)}
</div>`;
  const body = `<p class="hint">${esc(t(locale, 'admin.mail.intro'))}</p>${status}${unreadable}${cleartext}
${form('/admin/mail', csrf, fields, esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}${test}`;
  return shell(core, locale, admin, 'mail', t(locale, 'admin.section.mail'), body, msg);
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
    `<input id="ai-key" name="apiKey" type="password" data-reveal="off" maxlength="1000" autocomplete="off" spellcheck="false">`,
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
${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteProvider'))}`, 'danger', '', false, confirmAttrs(locale, QUESTIONS.provider(locale, p.name)))}</div>`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.providerPage', { name: p.name }), body, msg, base, aiBack(locale));
}

function aiModelPage(core: Core, locale: Locale, admin: User, id: string, msg?: Msg): string | null {
  const m = core.ai.getModel(id);
  if (!m) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/ai/models/${encodeURIComponent(m.id)}`;
  const body = `${form(base, csrf, modelFields(core, locale, m), esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}
<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteModel'))}`, 'danger', '', false, confirmAttrs(locale, QUESTIONS.model(locale, m.id)))}</div>`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.modelPage', { name: m.id }), body, msg, base, aiBack(locale));
}

function aiGroupPage(core: Core, locale: Locale, admin: User, id: string, msg?: Msg): string | null {
  const g = core.ai.getGroup(id);
  if (!g) return null;
  const csrf = csrfToken(core, admin);
  const base = `/admin/ai/groups/${encodeURIComponent(g.id)}`;
  const body = `${g.isDefault ? `<p class="hint">${esc(t(locale, 'admin.ai.groups.hint'))}</p>` : ''}${form(base, csrf, groupFields(core, locale, g), esc(t(locale, 'common.save')), 'primary', 'stack settings-form')}
${g.isDefault ? '' : `<div class="subsection">${form(`${base}/delete`, csrf, '', `${icon('trash')}${esc(t(locale, 'admin.ai.deleteGroup'))}`, 'danger', '', false, confirmAttrs(locale, QUESTIONS.aiGroup(locale, g.name)))}</div>`}`;
  return shell(core, locale, admin, 'ai', t(locale, 'admin.ai.groupPage', { name: aiGroupName(locale, g) }), body, msg, base, aiBack(locale));
}

function appsSection(core: Core, locale: Locale, admin: User, msg?: Msg): string {
  const csrf = csrfToken(core, admin);
  const emailOf = new Map(core.users.list().map((u) => [u.id, u.email]));
  const html = core.apps.listAllApps().map((app) => {
    const rows = core.apps.listInstances(app.id).map((i) => [
      `<a class="mono" href="${esc(instanceUrl(core.config, i.slug))}">${esc(i.slug)}</a>`, esc(emailOf.get(i.ownerId) ?? '–'), `<span class="num">v${i.activeVersion}</span>`,
      badge(visibilityLabel(locale, i.visibility), { icon: visibilityIcon(i.visibility) }), `<span class="num">${storageText(core, locale, i.id, storageUsed(core, i))}</span>`,
      i.disabled ? badge(t(locale, 'common.disabled'), { tone: 'danger', dot: true }) : badge(t(locale, 'common.active'), { tone: 'success', dot: true }),
      `<div class="btn-row">${form(`/admin/instances/${encodeURIComponent(i.slug)}/disabled`, csrf, hiddenField('disabled', i.disabled ? '0' : '1'), esc(t(locale, i.disabled ? 'common.activate' : 'common.deactivate')), 'quiet', '', true, '',
  namedAction(locale, t(locale, i.disabled ? 'common.activate' : 'common.deactivate'), i.slug))}
${linkButton(`/admin/instances/${encodeURIComponent(i.slug)}/domains`, `${icon('globe')}${esc(t(locale, 'admin.apps.domains'))}`, 'quiet', true, namedAction(locale, t(locale, 'admin.apps.domains'), i.slug))}</div>`,
    ]);
    const quota = `<form method="post" action="/admin/apps/${encodeURIComponent(app.id)}/quota" class="inline-form quota-form gap-bottom">${hiddenField('csrf', csrf)}`
      + `<label for="quota-${esc(app.id)}">${esc(t(locale, 'admin.quota.label'))}</label>${quotaInput(core, `quota-${app.id}`, core.quotas.ofApp(app.id), t(locale, 'admin.apps.quotaOf', { app: app.title }))}`
      + `<button type="submit" class="${btn('secondary', true)}"${namedAction(locale, t(locale, 'common.save'), t(locale, 'admin.apps.quotaOf', { app: app.title }))}>${esc(t(locale, 'common.save'))}</button></form>`;
    return `<section class="app-group subsection"><div class="app-group-head">${appTile(app, app.title, 'sm')}<div><h3>${esc(app.title)}</h3><span class="slug">${esc(app.slug)} · ${esc(emailOf.get(app.ownerId) ?? '–')}</span></div></div>
${quota}
${rows.length ? dataTable(locale, [t(locale, 'common.instance'), t(locale, 'common.owner'), t(locale, 'common.version'), t(locale, 'common.visibility'), t(locale, 'admin.apps.data'), t(locale, 'common.status'), ''], rows) : emptyState(t(locale, 'app.noInstances'))}</section>`;
  }).join('');
  const hint = `<p class="hint gap-bottom">${esc(t(locale, 'admin.apps.quotaHint', { size: defaultQuotaText(core, locale) }))}</p>`;
  return shell(core, locale, admin, 'apps', t(locale, 'admin.section.apps'), html ? `${hint}${html}` : emptyState(t(locale, 'admin.apps.none')), msg);
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

/** The sections of the administration that have a page of their own at /admin/<section>. */
const ADMIN_SECTIONS: ReadonlySet<string> = new Set(['users', 'groups', 'invites', 'mail', 'ai', 'apps', 'settings']);

/** The page a form under /admin belongs to, for a GET of the form's own address; null for addresses that are no form's. */
export function formPageOf(path: string): string | null {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'admin' || seg.length < 2) return null;
  // A form at a section's own address (adding a group, an invitation, saving the settings) belongs to that section's page.
  if (seg.length === 2) return ADMIN_SECTIONS.has(seg[1]) ? `/admin/${seg[1]}` : null;
  const [, section, id] = seg;
  if (section === 'users' || section === 'groups') return `/admin/${section}/${id}`;
  if (section === 'ai' && seg.length >= 4 && ['providers', 'models', 'groups'].includes(id)) return `/admin/ai/${id}/${seg[3]}`;
  if (section === 'instances' && seg[3] === 'domains') return `/admin/instances/${id}/domains`;
  if (section === 'instances') return '/admin/apps';
  if (ADMIN_SECTIONS.has(section)) return `/admin/${section}`;
  return null;
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
        // Back to the page the form is on: the same mapping as the GET of a form's address.
        send(res, 403, staleFormPage(localeOf(res), formPageOf(req.path) ?? '/admin', shellFor(core, req, user)));
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
  const failWith = (res: Response, e: unknown, view: (msg: Msg) => string | null, messages: Partial<Record<string, MessageKey>> = {}, field?: FieldError): void => {
    if (!(e instanceof LagerError)) throw e;
    const status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400;
    const locale = localeOf(res);
    const error = noticeText(locale, messages[e.code] ?? 'validation.generic');
    send(res, status, view({ error, ...(field ? { field } : {}) }) ?? missing(res.req, res, 'error.notFound.text', '/admin', 'admin.back'));
  };
  /** The field of a one-field form: control `id`, with what was typed into body field `name`. */
  const typed = (req: Request, id: string, name: string): FieldError => ({ id, values: { [id]: field(req, name, MAX_FIELD) } });

  /** The notice a form left for this page view, in the viewer's language. */
  const msgOf = (req: Request, res: Response): Msg => {
    const flash = readFlash(core, adminOf(res), req.query.flash);
    const locale = localeOf(res);
    return {
      ...(flash.ok ? { ok: noticeText(locale, flash.ok, flash.params) } : {}), ...(flash.error ? { error: noticeText(locale, flash.error, flash.params) } : {}),
      ...(flash.undo ? { undo: flash.undo } : {}),
    };
  };
  /** After a form: back to `path`, which says what happened, with a way to take it back where there is one. */
  const done = (res: Response, path: string, ok: MessageKey, params?: Record<string, string>, undo?: Undo): void => {
    res.redirect(flashUrl(core, adminOf(res), path, { ok, params, undo }));
  };
  /** After a form whose outcome is a success or a refusal: back to `path` with it, so reloading never sends the form again. */
  const redirectWith = (res: Response, path: string, flash: Flash): void => { res.redirect(flashUrl(core, adminOf(res), path, flash)); };
  /**
   * The question before a change that cannot be taken back, when the form came without the answer (no script): asked on a page of
   * its own that sends the same fields again. True when it was asked, so the route stops there.
   */
  const asked = (req: Request, res: Response, q: Question, cancel: string): boolean => {
    if (confirmed(req.body)) return false;
    send(res, 200, questionPage(localeOf(res), q, req, csrfToken(core, adminOf(res)), cancel, shellFor(core, req, adminOf(res))));
    return true;
  };
  const showUsers = (req: Request, res: Response): void => send(res, 200, usersSection(core, localeOf(res), adminOf(res), msgOf(req, res)));
  /** An account's page with a message, or the list when the account is gone. */
  const userView = (res: Response, user: User, id: string) => (m: Msg): string => userPage(core, localeOf(res), user, id, m) ?? usersSection(core, localeOf(res), user, m);
  router.get('/admin', noStore, admin, (req, res) => { showUsers(req, res); });
  router.get('/admin/users', noStore, admin, (req, res) => { showUsers(req, res); });
  router.get('/admin/users/:id', noStore, admin, (req, res) => {
    const html = userPage(core, localeOf(res), adminOf(res), param(req, 'id'), msgOf(req, res));
    if (html === null) send(res, 404, missing(req, res, 'admin.users.notFound', '/admin/users', 'admin.section.users'));
    else send(res, 200, html);
  });
  router.get('/admin/invites', noStore, admin, (req, res) => { send(res, 200, invitesSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });
  router.get('/admin/groups', noStore, admin, (req, res) => { send(res, 200, groupsSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });
  router.get('/admin/groups/:id', noStore, admin, (req, res) => {
    const html = groupPage(core, localeOf(res), adminOf(res), param(req, 'id'), msgOf(req, res));
    if (html === null) send(res, 404, missing(req, res, 'admin.groups.missing', '/admin/groups', 'admin.groups.all'));
    else send(res, 200, html);
  });
  router.get('/admin/settings', noStore, admin, (req, res) => { send(res, 200, settingsSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });
  router.get('/admin/mail', noStore, admin, (req, res) => { send(res, 200, mailSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });
  router.get('/admin/ai', noStore, admin, (req, res) => { send(res, 200, aiSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });
  for (const [kind, view] of [['providers', aiProviderPage], ['models', aiModelPage], ['groups', aiGroupPage]] as const) {
    router.get(`/admin/ai/${kind}/:id`, noStore, admin, (req, res) => {
      const html = view(core, localeOf(res), adminOf(res), param(req, 'id'), msgOf(req, res));
      if (html === null) send(res, 404, missing(req, res, 'admin.ai.notFound', '/admin/ai', 'admin.ai.all'));
      else send(res, 200, html);
    });
  }
  router.get('/admin/apps', noStore, admin, (req, res) => { send(res, 200, appsSection(core, localeOf(res), adminOf(res), msgOf(req, res))); });

  const domainInstanceOf = (req: Request): Instance => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) throw new LagerError('not_found', 'Instance not found.');
    return inst;
  };
  const showDomains = (res: Response, inst: Instance, status = 200, msg?: Msg): void => send(res, status, domainsPage(core, localeOf(res), adminOf(res), inst, msg));
  router.get('/admin/instances/:slug/domains', noStore, admin, (req, res) => {
    const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
    if (!inst) send(res, 404, missing(req, res, 'admin.instances.notFound', '/admin/apps', 'admin.section.apps'));
    else showDomains(res, inst, 200, msgOf(req, res));
  });
  for (const [route, change] of [['', 'add'], ['/remove', 'remove']] as const) {
    router.post(`/admin/instances/:slug/domains${route}`, ...action((req, res, user) => {
      try {
        const inst = domainInstanceOf(req);
        const host = field(req, 'host', MAX_FIELD);
        core.domains[change](inst, host, user, false);
        const path = `/admin/instances/${encodeURIComponent(inst.slug)}/domains`;
        if (change === 'add') done(res, path, 'notice.ok.domainAdded', { host: host.trim().toLowerCase() });
        else done(res, path, 'notice.ok.removed', { name: host }, { action: path, fields: { host } });
      } catch (e) {
        if (!(e instanceof LagerError)) throw e;
        const inst = core.apps.getInstanceBySlug(param(req, 'slug'));
        const key = (e.reason !== undefined ? DOMAIN_NOTICES[e.reason] : undefined) ?? (e.code === 'not_found' ? 'admin.instances.notFound' : 'validation.generic');
        if (!inst) send(res, 404, missing(req, res, 'admin.instances.notFound', '/admin/apps', 'admin.section.apps'));
        else showDomains(res, inst, e.code === 'conflict' ? 409 : e.code === 'forbidden' ? 403 : 400, { error: noticeText(localeOf(res), key), field: typed(req, 'domain-host', 'host') });
      }
    }));
  }

  // --- users ---

  const userMessages = { conflict: 'admin.users.lastAdmin', not_found: 'admin.users.notFound', invalid_argument: 'validation.generic', forbidden: 'admin.users.disableSelf' } as const;

  router.post('/admin/users/:id/role', ...action((req, res, user) => {
    try {
      const u = core.users.setRole(param(req, 'id'), field(req, 'role') as Role);
      done(res, userPath(u.id), 'notice.ok.role', { name: u.name || u.email, role: roleLabel(localeOf(res), u.role) });
    } catch (e) { failWith(res, e, userView(res, user, param(req, 'id')), userMessages); }
  }));

  router.post('/admin/users/:id/disabled', ...action((req, res, user) => {
    const value = field(req, 'disabled');
    try {
      if (value !== '0' && value !== '1') throw new LagerError('invalid_argument', 'disabled must be 0 or 1.');
      // Deactivating signs the account out everywhere: one's own session would end with it. The page does not offer it either.
      if (value === '1' && param(req, 'id') === user.id) throw new LagerError('forbidden', 'You cannot deactivate your own account.', 'disable_self');
      const wasDisabled = core.users.get(param(req, 'id'))?.disabled;
      const u = core.users.setDisabled(param(req, 'id'), value === '1');
      done(res, userPath(u.id), u.disabled ? 'notice.ok.userDisabled' : 'notice.ok.userEnabled', { name: u.name || u.email },
        u.disabled && !wasDisabled ? { action: `${userPath(u.id)}/disabled`, fields: { disabled: '0' } } : undefined);
    } catch (e) { failWith(res, e, userView(res, user, param(req, 'id')), userMessages); }
  }));

  router.post('/admin/users/:id/reset-link', ...action((req, res, user) => {
    try {
      const link = core.accounts.createResetLink(param(req, 'id'));
      send(res, 200, userView(res, user, param(req, 'id'))({ once: { title: t(localeOf(res), 'admin.users.resetLinkTitle'), link } }));
    } catch (e) { failWith(res, e, userView(res, user, param(req, 'id')), userMessages); }
  }));

  /**
   * For someone who lost both their authenticator app and their recovery codes. Never for the administrator's own account (they
   * use their account page, with a code), and only after the administrator confirmed with their own password and code. The
   * account is signed out everywhere and its owner gets a mail.
   */
  const confirmTries = new RateLimiter(10, 15 * 60_000);
  const resetTarget = (req: Request, res: Response, user: User): User | null => {
    const locale = localeOf(res);
    const target = core.users.get(param(req, 'id'));
    if (!target) { send(res, 404, usersSection(core, locale, user, { error: t(locale, 'admin.users.notFound') })); return null; }
    if (target.id === user.id) { send(res, 403, userView(res, user, target.id)({ error: t(locale, 'admin.users.twoFactorSelf') })); return null; }
    if (!core.twoFactor.isEnabled(target.id)) { res.redirect(userPath(target.id)); return null; }
    return target;
  };

  router.get('/admin/users/:id/two-factor/reset', noStore, admin, (req, res) => {
    const user = adminOf(res);
    const target = resetTarget(req, res, user);
    if (target) send(res, 200, twoFactorResetPage(core, localeOf(res), user, target));
  });

  router.post('/admin/users/:id/two-factor/reset', ...action(async (req, res, user) => {
    const locale = localeOf(res);
    const target = resetTarget(req, res, user);
    if (!target) return;
    const again = (status: number, error: string): void => send(res, status, twoFactorResetPage(core, locale, user, target, { error }));
    if (!confirmTries.hit(user.id)) { again(429, t(locale, 'account.tooMany')); return; }
    if (!(await core.users.checkLogin(user.email, field(req, 'current', Infinity), true)).ok) { again(400, t(locale, 'account.password.wrong')); return; }
    if (core.twoFactor.isEnabled(user.id)) {
      const result = core.twoFactor.check(user.id, field(req, 'code', 100));
      if (!result.ok) {
        if (result.reason === 'locked' && result.started) core.accounts.noticeTwoFactor(user, 'locked', locale);
        again(result.reason === 'locked' ? 429 : 400, codeRefusal(locale, result));
        return;
      }
      if (result.method === 'recovery') core.accounts.noticeTwoFactor(user, 'recovery', locale, result.recoveryLeft);
    }
    confirmTries.reset(user.id);
    if (core.twoFactor.disable(target.id)) {
      // Out everywhere, as when the second step is turned on: sessions, instance codes, assistants and API tokens.
      core.users.bumpEpoch(target.id);
      core.oauth.revokeUser(target.id);
      core.tokens.revokeAll(target.id);
      core.accounts.noticeTwoFactor(target, 'reset');
    }
    redirectWith(res, userPath(target.id), { ok: 'admin.users.twoFactorResetDone', params: { email: target.email } });
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
    send(res, status, (stays ? deleteUserPage(core, locale, user, id, { error }, answered) : null) ?? userView(res, user, id)({ error }));
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
    if (field(req, 'decision') !== 'delete') { res.redirect(core.users.get(id) ? userPath(id) : '/admin/users'); return; }
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
      // The account is gone either way; files that could not be moved are the administrator's to look at, in the log.
      redirectWith(res, '/admin/users', cleanedUp
        ? { ok: 'admin.users.delete.done', params: { email: target.email } }
        : { error: 'admin.users.delete.cleanupFailed', params: { email: target.email } });
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
    } catch (e) { failWith(res, e, (m) => invitesSection(core, localeOf(res), user, m), { invalid_argument: 'admin.invites.invalid' }, typed(req, 'invite-email', 'email')); }
  }));

  router.post('/admin/invites/:id/revoke', ...action((req, res, user) => {
    if (asked(req, res, QUESTIONS.invite(localeOf(res)), '/admin/invites')) return;
    if (!core.accounts.revokeInvite(param(req, 'id'))) {
      send(res, 404, invitesSection(core, localeOf(res), user, { error: t(localeOf(res), 'admin.invites.notFound') }));
      return;
    }
    done(res, '/admin/invites', 'notice.ok.inviteRevoked');
  }));

  // --- groups ---

  const groupMessages = { conflict: 'admin.groups.exists', invalid_argument: 'admin.groups.nameInvalid', not_found: 'admin.groups.notFound' } as const;

  router.post('/admin/groups', ...action((req, res, user) => {
    try {
      const group = core.groups.create(field(req, 'name'));
      done(res, '/admin/groups', 'notice.ok.created', { name: group.name });
    } catch (e) { failWith(res, e, (m) => groupsSection(core, localeOf(res), user, m), groupMessages, typed(req, 'group-name', 'name')); }
  }));

  router.post('/admin/groups/:id/rename', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.groups.rename(id, field(req, 'name'));
      done(res, `/admin/groups/${encodeURIComponent(id)}`, 'notice.ok.renamed', { name: core.groups.get(id)?.name ?? '' });
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), groupMessages, typed(req, 'group-name', 'name')); }
  }));

  router.post('/admin/groups/:id/members', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      const member = core.users.getByEmail(field(req, 'email', 254));
      if (!member) throw new LagerError('not_found', 'No account with this email address.');
      core.groups.addMember(id, member.id);
      done(res, `/admin/groups/${encodeURIComponent(id)}`, 'notice.ok.memberAdded', { name: member.name || member.email });
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), { ...groupMessages, not_found: core.groups.get(id) ? 'notice.noAccount' : 'admin.groups.notFound' }, typed(req, 'member-email', 'email')); }
  }));

  router.post('/admin/groups/:id/members/:userId/remove', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      const member = core.users.get(param(req, 'userId'));
      // Undo only for a membership this press ended: on a stale page it would undo another administrator's decision.
      const wasMember = core.groups.members(id).some((m) => m.id === param(req, 'userId'));
      core.groups.removeMember(id, param(req, 'userId'));
      const base = `/admin/groups/${encodeURIComponent(id)}`;
      done(res, base, 'notice.ok.memberRemoved', { name: member ? member.name || member.email : '' }, member && wasMember ? { action: `${base}/members`, fields: { email: member.email } } : undefined);
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), groupMessages); }
  }));

  /** The storage field in MiB: empty follows the next rule (null); anything but a whole number is refused by `Quotas`. */
  const quotaField = (req: Request): number | null => {
    const raw = field(req, 'quota', 20).trim();
    if (raw === '') return null;
    return /^\d+$/.test(raw) ? Number(raw) * MIB : NaN;
  };
  const quotaMessages = { invalid_argument: 'admin.quota.invalid' } as const;

  router.post('/admin/groups/:id/quota', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.quotas.setGroup(id, quotaField(req));
      done(res, `/admin/groups/${encodeURIComponent(id)}`, 'notice.ok.saved');
    } catch (e) { failWith(res, e, (m) => groupPage(core, localeOf(res), user, id, m), { ...groupMessages, ...quotaMessages }, typed(req, 'group-quota', 'quota')); }
  }));

  router.post('/admin/apps/:id/quota', ...action((req, res, user) => {
    try {
      core.quotas.setApp(param(req, 'id'), quotaField(req));
      done(res, '/admin/apps', 'notice.ok.saved');
    } catch (e) { failWith(res, e, (m) => appsSection(core, localeOf(res), user, m), { ...quotaMessages, not_found: 'error.notFound.text' }, typed(req, `quota-${param(req, 'id')}`, 'quota')); }
  }));

  router.post('/admin/groups/:id/delete', ...action((req, res, user) => {
    try {
      const name = core.groups.get(param(req, 'id'))?.name ?? '';
      if (name && asked(req, res, QUESTIONS.group(localeOf(res), name, core.groups.members(param(req, 'id')).length, core.groups.sharesOf(param(req, 'id'))), `/admin/groups/${encodeURIComponent(param(req, 'id'))}`)) return;
      core.groups.delete(param(req, 'id'));
      done(res, '/admin/groups', 'notice.ok.deleted', { name });
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
      done(res, '/admin/settings', 'notice.ok.saved');
    } catch (e) { failWith(res, e, (m) => settingsSection(core, localeOf(res), user, m), { invalid_argument: 'admin.settings.invalid' }); }
  }));

  // --- mail ---

  router.post('/admin/mail', ...action((req, res, user) => {
    const locale = localeOf(res);
    if (core.mailSource === 'env') {
      send(res, 409, mailSection(core, locale, user, { error: t(locale, 'admin.mail.env') }));
      return;
    }
    try {
      const security = field(req, 'security') as SmtpSecurity;
      if (!SMTP_SECURITY.includes(security)) throw new LagerError('invalid_argument', 'Encryption must be tls, starttls or none.');
      const rawPort = field(req, 'port').trim();
      const port = rawPort === '' ? { tls: 465, starttls: 587, none: 25 }[security] : /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      const password = field(req, 'password', MAX_SMTP_PASSWORD + 1);
      const { passwordDropped } = core.mailSettings.save({ host: field(req, 'host'), port, security, user: field(req, 'user'), password: password === '' ? undefined : password, from: field(req, 'from') });
      // Registration must not open by itself at the next restart just because mail is on now. Only after a save that succeeded.
      core.settings.keepRegistration();
      redirectWith(res, '/admin/mail', { ok: passwordDropped ? 'admin.mail.savedPasswordDropped' : 'admin.mail.saved' });
    } catch (e) { failWith(res, e, (m) => mailSection(core, locale, user, m), { invalid_argument: 'admin.mail.invalid' }); }
  }));

  router.post('/admin/mail/test', ...action(async (_req, res, user) => {
    const locale = localeOf(res);
    if (!core.mailer.enabled) {
      send(res, 409, mailSection(core, locale, user, { error: t(locale, 'admin.mail.status.off') }));
      return;
    }
    try {
      await core.mailer.send({ to: user.email, subject: t(locale, 'admin.mail.testSubject'), text: `${t(locale, 'admin.mail.testText', { url: core.config.publicUrl.origin })}\n` });
      redirectWith(res, '/admin/mail', { ok: 'admin.mail.testOk', params: { email: user.email } });
    } catch (e) {
      // The error code and the SMTP reply tell a wrong password from a server that is down; nothing else the far end said is shown.
      redirectWith(res, '/admin/mail', { error: 'admin.mail.testFailed', params: { error: smtpErrorText(e) } });
    }
  }));

  router.post('/admin/mail/delete', ...action((req, res, user) => {
    if (core.mailSource === 'env') {
      send(res, 409, mailSection(core, localeOf(res), user, { error: t(localeOf(res), 'admin.mail.env') }));
      return;
    }
    if (asked(req, res, QUESTIONS.mail(localeOf(res)), '/admin/mail')) return;
    core.mailSettings.clear();
    redirectWith(res, '/admin/mail', { ok: 'admin.mail.removed' });
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
      const input = providerInput(req);
      core.ai.createProvider(input);
      done(res, '/admin/ai', 'notice.ok.created', { name: input.name });
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/providers/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateProvider(id, providerInput(req));
      done(res, '/admin/ai', 'notice.ok.saved');
    } catch (e) { aiFail(res, user, e, (m) => aiProviderPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/providers/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    const locale = localeOf(res);
    try {
      const name = core.ai.getProvider(id)?.name ?? id;
      if (core.ai.getProvider(id) && asked(req, res, QUESTIONS.provider(locale, name), `/admin/ai/providers/${encodeURIComponent(id)}`)) return;
      core.ai.deleteProvider(id);
      done(res, '/admin/ai', 'notice.ok.deleted', { name });
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
      redirectWith(res, `/admin/ai/providers/${encodeURIComponent(id)}`, { ok: 'admin.ai.testOk', params: { model: out.model, answer } });
    } catch (e) {
      if (e instanceof AiError) {
        // The administrator sees what the provider said; app viewers never do.
        redirectWith(res, `/admin/ai/providers/${encodeURIComponent(id)}`, { error: 'admin.ai.testFailed', params: { error: [e.message, e.detail].filter(Boolean).join(' ') } });
        return;
      }
      aiFail(res, user, e, (m) => aiProviderPage(core, locale, user, id, m));
    }
  }));

  router.post('/admin/ai/models', ...action((req, res, user) => {
    try {
      const input = modelInput(req);
      core.ai.createModel(input);
      done(res, '/admin/ai', 'notice.ok.created', { name: input.id ?? input.model });
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/models/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateModel(id, modelInput(req));
      done(res, '/admin/ai', 'notice.ok.saved');
    } catch (e) { aiFail(res, user, e, (m) => aiModelPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/models/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    const locale = localeOf(res);
    try {
      if (core.ai.getModel(id) && asked(req, res, QUESTIONS.model(locale, id), `/admin/ai/models/${encodeURIComponent(id)}`)) return;
      core.ai.deleteModel(id);
      done(res, '/admin/ai', 'notice.ok.deleted', { name: id });
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
      const input = groupInput(req);
      core.ai.createGroup(input);
      done(res, '/admin/ai', 'notice.ok.created', { name: input.name });
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/ai/groups/:id', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      core.ai.updateGroup(id, groupInput(req));
      done(res, '/admin/ai', 'notice.ok.saved');
    } catch (e) { aiFail(res, user, e, (m) => aiGroupPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/groups/:id/delete', ...action((req, res, user) => {
    const id = param(req, 'id');
    try {
      const g = core.ai.getGroup(id);
      const name = g?.name ?? id;
      if (g && !g.isDefault && asked(req, res, QUESTIONS.aiGroup(localeOf(res), name), `/admin/ai/groups/${encodeURIComponent(id)}`)) return;
      core.ai.deleteGroup(id);
      done(res, '/admin/ai', 'notice.ok.deleted', { name });
    } catch (e) { aiFail(res, user, e, (m) => aiGroupPage(core, localeOf(res), user, id, m)); }
  }));

  router.post('/admin/ai/max-tokens', ...action((req, res, user) => {
    try {
      core.ai.setMaxTokens(int(req, 'maxTokens'));
      done(res, '/admin/ai', 'notice.ok.saved');
    } catch (e) { aiFail(res, user, e, (m) => aiSection(core, localeOf(res), user, m)); }
  }));

  router.post('/admin/users/:id/ai-group', ...action((req, res, user) => {
    try {
      const id = param(req, 'id');
      core.ai.assign(id, field(req, 'group'));
      const u = core.users.get(id)!;
      const group = core.ai.listGroups().find((g) => g.id === core.ai.groupIdOf(id));
      done(res, userPath(id), 'notice.ok.aiGroup', { name: u.name || u.email, group: group ? aiGroupName(localeOf(res), group) : '' });
    } catch (e) { failWith(res, e, userView(res, user, param(req, 'id')), { not_found: 'admin.ai.notFound' }); }
  }));

  // --- instances ---

  router.post('/admin/instances/:slug/disabled', ...action((req, res, user) => {
    const value = field(req, 'disabled');
    try {
      const instance = core.apps.getInstanceBySlug(param(req, 'slug'));
      if (!instance) throw new LagerError('not_found', 'Instance not found.');
      if (value !== '0' && value !== '1') throw new LagerError('invalid_argument', 'disabled must be 0 or 1.');
      core.apps.setInstanceDisabled(instance.id, value === '1');
      done(res, '/admin/apps', value === '1' ? 'notice.ok.instanceDisabled' : 'notice.ok.instanceEnabled', { slug: instance.slug },
        value === '1' && !instance.disabled ? { action: `/admin/instances/${encodeURIComponent(instance.slug)}/disabled`, fields: { disabled: '0' } } : undefined);
    } catch (e) { failWith(res, e, (m) => appsSection(core, localeOf(res), user, m), { not_found: 'admin.instances.notFound' }); }
  }));

  // A page some forms answer with stays at the form's address (a one-time link, a refusal). Opening that address again, from the
  // address bar, a bookmark or a reload, leads to the page the form belongs to instead of a dead end.
  router.get('/admin/*rest', (req, res, next) => {
    const to = formPageOf(req.path);
    if (to) res.redirect(to); else next();
  });
};
