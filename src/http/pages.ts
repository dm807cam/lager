import crypto from 'node:crypto';
import { MAX_SLUG_LENGTH } from '../config.js';
import { MAX_NAME as MAX_GROUP_NAME } from '../platform/groups.js';
import { MAX_NAME as MAX_TOKEN_NAME } from '../platform/tokens.js';
import { MAX_QUOTA_MB } from '../platform/quotas.js';
import { formatDate, formatSize, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { staticUrls } from './static.js';
import { avatar, btn, copyButton, icon, notice, SPRITE, type ButtonStyle, type IconName, type NavItem } from './ui.js';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Runs before the stylesheet applies, so a stored theme choice shows from the first paint. It only reads one value and
 * sets one attribute, and cannot throw (storage may be blocked).
 */
const THEME_SNIPPET = 'try{var t=localStorage.getItem("lager-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}';

/**
 * The content security policy of a platform page, carried by the page itself so that every page of the shell has it, whichever
 * route sends it (`frame-ancestors` cannot be set this way and stays a response header). Scripts run only from the platform's
 * own files or with this response's nonce, which the one inline script (the theme snippet) carries: markup that slips into a
 * page cannot run. Inline styles stay allowed, the pages use them for colours and meters.
 * Browsers apply `form-action` to the redirects that follow a form post as well, so it names every origin a form of the page
 * can end on (`formAction`): the platform alone on the pages of the signed-in shell, the platform and the instance on the
 * question before a sign-in to that instance. Pages whose forms end where the page cannot know (signing in returns to
 * whichever instance or client sent the visitor, consenting goes to the connecting client) carry no `form-action`.
 */
const contentSecurityPolicy = (nonce: string, formAction: readonly string[] | null): string =>
  `script-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'none'${formAction ? `; form-action ${["'self'", ...formAction].join(' ')}` : ''}`;

export interface PageOpts {
  /** Where the language switcher sends the visitor back to (a local path); the start page when left out. */
  returnPath?: string;
  /** Instance hosts do not share the platform's language cookie, so their pages carry no switcher. */
  switcher?: boolean;
  /** The signed-in account: the page gets the top bar with navigation and account menu. Without it, the signed-out layout. */
  user?: { id: string; name: string; email: string; admin: boolean; publisher?: boolean };
  /** CSRF token for the sign-out form of the account menu. */
  csrf?: string;
  /** The navigation item this page belongs to. */
  current?: NavItem | null;
  /** Whether the server offers the viewer anything in the catalog: the navigation lists it then. */
  catalog?: boolean;
  /**
   * Origin of the platform host, for pages served on instance hosts: the stylesheet and icons are loaded from there by
   * absolute URL, and such pages get no script.
   */
  origin?: string;
  /** A larger icon above the content of a signed-out page (the sign-in page). */
  hero?: boolean;
  /**
   * Origins besides the platform's own that a form of this page may end on, redirects included (`https://notes.apps.example.com`).
   * Given, the page allows exactly those; left out, a signed-in page allows only the platform and a signed-out page any target.
   */
  formTargets?: readonly string[];
}

/** Options for a page on an instance host: no language switcher (the platform's cookie is not sent there), styles from the platform host. */
export const instanceHostPage = (config: { publicUrl: URL }): PageOpts => ({ switcher: false, origin: config.publicUrl.origin });

function languageLinks(locale: Locale, returnPath: string, cls: string): string {
  return LOCALES.map((l) =>
    `<a href="/lang/${l}?return=${encodeURIComponent(returnPath)}" lang="${l}" hreflang="${l}"${cls ? ` class="${cls}"` : ''}${l === locale ? ' aria-current="true"' : ''}>${esc(LOCALE_NAMES[l])}</a>`).join('');
}

/** Footer with one link per language; `GET /lang/<locale>` stores the choice and redirects to `returnPath`. */
function footer(locale: Locale, returnPath: string | null): string {
  if (returnPath === null) return '';
  return `<footer class="site-footer"><nav aria-label="${esc(t(locale, 'footer.language'))}">${icon('globe', 'i-sm')}<span class="sr-only">${esc(t(locale, 'footer.language'))}</span>${languageLinks(locale, returnPath, '')}</nav></footer>`;
}

/**
 * `tab` is the shorter label of the phone tab bar. Only one of the two labels is displayed at a time (the other is `display: none`),
 * so the link's accessible name is always the text on screen, and voice control finds the link by what it shows.
 */
const NAV: Array<{ id: NavItem; href: string; key: MessageKey; tab: MessageKey; icon: IconName }> = [
  { id: 'apps', href: '/', key: 'nav.apps', tab: 'nav.tab.apps', icon: 'grid' },
  { id: 'catalog', href: '/catalog', key: 'dash.catalog', tab: 'dash.catalog', icon: 'compass' },
  { id: 'publish', href: '/publish', key: 'nav.publish', tab: 'nav.tab.publish', icon: 'upload' },
  { id: 'admin', href: '/admin', key: 'nav.admin', tab: 'nav.tab.admin', icon: 'shield' },
];

/** The top bar of signed-in pages: brand, primary navigation (a tab bar on phones), language and account menus. */
function topBar(locale: Locale, opts: PageOpts, returnPath: string): { html: string; tabbar: boolean } {
  const user = opts.user!;
  const items = NAV.filter((n) => n.id === 'apps' || (n.id === 'catalog' && opts.catalog) || (n.id === 'publish' && user.publisher) || (n.id === 'admin' && user.admin));
  // A navigation with a single destination is noise: the brand already links home.
  const nav = items.length > 1 ? `<nav class="primary" aria-label="${esc(t(locale, 'nav.main'))}">${items.map((n) =>
    `<a href="${n.href}"${n.id === opts.current ? ' aria-current="page"' : ''}>${icon(n.icon)}<span class="nav-full">${esc(t(locale, n.key))}</span><span class="nav-short">${esc(t(locale, n.tab))}</span></a>`).join('')}</nav>` : '';
  const lang = opts.switcher === false ? '' : `<details class="menu lang-menu"><summary class="menu-trigger">${icon('globe', 'i-sm')}<span aria-hidden="true">${locale}</span><span class="sr-only">${esc(t(locale, 'footer.language'))}</span></summary>
<div class="menu-panel">${languageLinks(locale, returnPath, 'menu-item')}</div></details>`;
  const theme = `<button type="button" class="menu-item" data-theme-toggle data-system="${esc(t(locale, 'theme.system'))}" data-light="${esc(t(locale, 'theme.light'))}" data-dark="${esc(t(locale, 'theme.dark'))}" hidden>${icon('sun')}<span>${esc(t(locale, 'theme.label'))} <span data-theme-name>${esc(t(locale, 'theme.system'))}</span></span></button>`;
  const account = `<details class="menu account-menu"><summary class="menu-trigger avatar-trigger">${avatar(user)}<span class="sr-only">${esc(t(locale, 'nav.account'))}</span></summary>
<div class="menu-panel"><div class="menu-head">${avatar(user, 'lg')}<div><strong>${esc(user.name || user.email)}</strong><span>${esc(user.email)}</span></div></div>
<a class="menu-item" href="/account">${icon('user')}${esc(t(locale, 'nav.account'))}</a>${theme}<div class="menu-sep"></div>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(opts.csrf ?? '')}"><button type="submit">${icon('logout')}${esc(t(locale, 'nav.signOut'))}</button></form></div></details>`;
  return {
    html: `<header class="topbar"><div class="topbar-in"><a class="brand" href="/"><img src="/icon.webp" alt="" width="32" height="32"><span>Lager</span></a>${nav}<div class="topbar-end">${lang}${account}</div></div></header>`,
    tabbar: nav !== '',
  };
}

/**
 * Shared shell. Signed-in pages (`opts.user`) get the top bar and a wide content area; all others the signed-out layout:
 * a small brand bar, a centred column and the language footer (unless `switcher` is false). Signed-in pages switch language in the top bar.
 */
export function page(locale: Locale, title: string, body: string, opts: PageOpts = {}): string {
  const origin = opts.origin ?? '';
  const { css, js } = staticUrls();
  const returnPath = opts.returnPath ?? '/';
  const switcherPath = opts.switcher === false ? null : returnPath;
  const skip = `<a class="skip" href="#main">${esc(t(locale, 'nav.skip'))}</a>`;
  let content: string;
  let bodyClass: string;
  if (opts.user) {
    const bar = topBar(locale, opts, returnPath);
    bodyClass = bar.tabbar ? 'app-body has-tabbar' : 'app-body';
    // The top bar's language menu is the switcher here; a second language navigation in the footer would only repeat it.
    content = `${skip}${bar.html}<main id="main" class="page">${body}</main>`;
  } else {
    bodyClass = 'auth-body';
    const brand = opts.hero
      ? `<a class="brand brand-hero" href="/"><img src="/icon.webp" alt="" width="64" height="64"><span class="sr-only">Lager</span></a>`
      : `<a class="brand" href="${esc(origin || '/')}"><img src="${origin}/icon.webp" alt="" width="32" height="32"><span>Lager</span></a>`;
    content = `${skip}<header class="auth-top${opts.hero ? ' is-hero' : ''}">${brand}</header><main id="main" class="auth">${body}</main>${footer(locale, switcherPath)}`;
  }
  // A fresh nonce for every page, so one that leaked from an earlier response is worth nothing.
  const nonce = crypto.randomBytes(16).toString('base64');
  // Instance hosts get no script and no platform manifest: those belong to the platform host.
  const head = origin
    ? `<link rel="stylesheet" href="${origin}${css}"><link rel="icon" type="image/webp" href="${origin}/icon.webp">`
    : `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce, opts.formTargets ?? (opts.user ? [] : null))}">
<script id="theme-init" nonce="${nonce}">${THEME_SNIPPET}</script><link rel="stylesheet" href="${css}">
<link rel="icon" type="image/webp" href="/icon.webp">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><script src="${js}" defer></script>`;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#1f2a5c">
${head}</head>
<body class="${bodyClass}"${origin ? '' : ` data-show-password="${esc(t(locale, 'password.show'))}" data-hide-password="${esc(t(locale, 'password.hide'))}"`}>${SPRITE}${content}</body></html>`;
}

/** Signed-out content: a card, optionally with an icon above the heading; `inner` is trusted markup. */
export const authCard = (inner: string): string => `<div class="auth-card">${inner}</div>`;

/**
 * The card of a message or error page. A signed-in viewer (`opts.user`) keeps the top bar and the navigation around it, so
 * a wrong address or a refused action is not a dead end; the card then sits in the same narrow column as on signed-out pages.
 */
const messageCard = (inner: string, opts: PageOpts): string => (opts.user ? `<div class="auth">${authCard(inner)}</div>` : authCard(inner));

/** Page with one heading and one line of text. */
export const messagePage = (locale: Locale, title: string, text: string, extra = '', opts: PageOpts = {}, tone: 'neutral' | 'danger' | 'success' = 'neutral'): string =>
  page(locale, title, messageCard(`<div class="auth-icon${tone === 'neutral' ? '' : ` is-${tone}`}">${icon(tone === 'success' ? 'check' : 'alert')}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}`, opts), opts);

/** Resend form shown wherever an unverified address needs a new confirmation link. */
export const resendForm = (locale: Locale, email = ''): string => `<form method="post" action="/verify/resend" class="stack">
<div class="field"><label for="resend-email">${esc(t(locale, 'common.email'))}</label><input id="resend-email" name="email" type="email" autocomplete="email" required value="${esc(email)}"></div>
<button type="submit" class="${btn('secondary')}">${esc(t(locale, 'auth.resend.button'))}</button>
</form>`;

/**
 * `email` is what the visitor typed in an attempt that failed: it comes back in the field, so only the password is typed again
 * (the password itself never comes back). The link to create an account shows only while anyone may register; with
 * invitations only or registration closed it would lead a visitor without an invitation to a page that turns them away.
 */
export function loginPage(locale: Locale, returnPath: string, error?: string, opts: { registration?: 'open' | 'invite' | 'closed'; resendEmail?: string; notice?: string; email?: string } = {}): string {
  const typed = opts.email ?? '';
  // A refused sign-in is about both fields: each says so to assistive technology and points at the message.
  const invalid = error ? ' aria-invalid="true" aria-describedby="login-error"' : '';
  return page(locale, t(locale, 'login.title'), `<div class="auth-hero"><h1>${esc(t(locale, 'brand.tagline'))}</h1></div>
<div class="auth-card"><h2>${esc(t(locale, 'login.title'))}</h2>
${opts.notice ? notice('success', opts.notice) : ''}${error ? notice('danger', error).replace('<div class="notice', '<div id="login-error" class="notice') : ''}
<form method="post" action="/login" class="stack">
<input type="hidden" name="return" value="${esc(returnPath)}">
<div class="field"><label for="email">${esc(t(locale, 'common.email'))}</label><input id="email" name="email" type="email" autocomplete="username" required${typed ? ` value="${esc(typed)}"` : ' autofocus'}${invalid}></div>
<div class="field"><label for="password">${esc(t(locale, 'common.password'))}</label><input id="password" name="password" type="password" autocomplete="current-password" required${typed ? ' autofocus' : ''}${invalid}></div>
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'login.submit'))}</button>
</form>
${opts.resendEmail !== undefined ? resendForm(locale, opts.resendEmail) : ''}</div>
<p class="auth-links"><a href="/forgot">${esc(t(locale, 'login.forgot'))}</a>${opts.registration === 'open' ? `<a href="/register">${esc(t(locale, 'login.register'))}</a>` : ''}</p>
<p class="pitch">${esc(t(locale, 'brand.pitch'))}</p>`, { hero: true, returnPath: returnPath === '/' ? '/login' : `/login?return=${encodeURIComponent(returnPath)}` });
}

/** On the platform host the page offers a way back; on instance hosts the brand link leads to the platform. */
export const notFoundPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.notFound.title'), t(locale, 'error.notFound.text'), opts.origin ? '' : backLink(locale), opts);
export const forbiddenPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'error.forbidden.text'), '', opts, 'danger');
export const disabledPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.disabled.title'), t(locale, 'error.disabled.text'), '', opts);
export const badCodePage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.badCode.title'), t(locale, 'error.badCode.text'), '', opts, 'danger');
/**
 * A form post whose CSRF token was missing or stale: the page was open too long, or the account signed in again elsewhere. It says
 * so, and its one button opens the page the form was on (`back`, a local path), fresh, with a new token. Nothing suggests a reload,
 * which would send the same stale form again.
 */
export function staleFormPage(locale: Locale, back = '/', opts: PageOpts = {}): string {
  const title = t(locale, 'error.stale.title');
  return page(locale, title, messageCard(`<div class="auth-icon is-danger">${icon('alert')}</div><h1>${esc(title)}</h1><p>${esc(t(locale, 'error.stale.text'))}</p>
<div class="btn-row gap-top"><a class="${btn('primary')}" href="${esc(back)}">${esc(t(locale, 'error.stale.back'))}</a></div>`, opts), { ...opts, returnPath: back });
}

export const backLink = (locale: Locale, href = '/', label = t(locale, 'common.backToOverview')): string => `<p class="auth-links"><a href="${esc(href)}">${esc(label)}</a></p>`;

/** The administration area to anyone who is not an administrator. */
export const forbiddenAdminPage = (locale: Locale, opts: PageOpts = {}): string => messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.admin'), backLink(locale), opts, 'danger');

/** Catalog texts that quote a limit; the numbers come from the constants the code enforces. */
const LIMITS: Partial<Record<MessageKey, { max: number }>> = {
  'notice.slugInvalid': { max: MAX_SLUG_LENGTH },
  'dash.tokens.nameInvalid': { max: MAX_TOKEN_NAME },
  'admin.groups.nameInvalid': { max: MAX_GROUP_NAME },
  'admin.quota.invalid': { max: MAX_QUOTA_MB },
};
/** Notice and error texts: `t` plus the limits they quote and the values a flash brought along. */
export const noticeText = (locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string => t(locale, key, { ...params, ...LIMITS[key] });

const hidden = (fields: Record<string, string>): string =>
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');

const CLIENT_MARK = '\u0001client\u0001';
const HOST_MARK = '\u0001host\u0001';
/** Catalog text with sentinel parameters: the text is escaped first, then each sentinel becomes the escaped value in bold. */
const emphasise = (text: string, marks: Record<string, string>): string =>
  Object.entries(marks).reduce((html, [mark, value]) => html.replaceAll(mark, () => `<strong>${esc(value)}</strong>`), esc(text));

/** OAuth consent: names the connecting client and where the browser is sent afterwards. Deny comes first, so Enter never approves. */
export function consentPage(locale: Locale, clientName: string, redirect: { kind: 'web' | 'app'; target: string }, userName: string, fields: Record<string, string>): string {
  return page(locale, t(locale, 'consent.title'), authCard(`<div class="auth-icon">${icon('shield')}</div><h1>${esc(t(locale, 'consent.heading'))}</h1>
<div class="consent-who"><p>${emphasise(t(locale, 'consent.text', { client: CLIENT_MARK }), { [CLIENT_MARK]: clientName })}</p>
<p>${emphasise(t(locale, redirect.kind === 'web' ? 'consent.signedIn' : 'consent.signedInApp', { user: userName, host: HOST_MARK }), { [HOST_MARK]: redirect.target })}</p></div>
<form method="post" action="/authorize">
${hidden(fields)}
<div class="consent-actions"><button type="submit" name="decision" value="deny" class="${btn('secondary')}">${esc(t(locale, 'consent.deny'))}</button>
<button type="submit" name="decision" value="approve" class="${btn('primary')}">${esc(t(locale, 'consent.approve'))}</button></div>
</form>`), { switcher: false });
}

export const consentInvalidPage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'consent.invalid.title'), t(locale, 'consent.invalid.text'), '', { switcher: false }, 'danger');

// --- shared pieces of the signed-in pages ---

/** Date and time as HTML text in the viewer's format. */
/**
 * Date and time as HTML: a `<time>` that names UTC, which the platform script rewrites in the viewer's own time zone (pages on
 * instance hosts and browsers without the script keep the UTC text, which says what it is).
 */
export const dateText = (locale: Locale, iso: string): string => `<time datetime="${esc(iso)}" data-local="datetime">${esc(formatDate(locale, iso, true))}</time>`;
export const sizeText = (locale: Locale, bytes: number): string => esc(formatSize(locale, bytes));

const VISIBILITY_KEYS: Record<string, MessageKey> = { private: 'visibility.private', users: 'visibility.users', public: 'visibility.public' };
const LEVEL_KEYS: Record<string, MessageKey> = { view: 'level.view', interact: 'level.interact', admin: 'level.admin', owner: 'level.owner' };
export type Option = readonly [string, string];

const labelOf = (locale: Locale, keys: Record<string, MessageKey>, value: string): string => (Object.hasOwn(keys, value) ? t(locale, keys[value]) : value);
export const visibilityLabel = (locale: Locale, v: string): string => labelOf(locale, VISIBILITY_KEYS, v);
export const levelLabel = (locale: Locale, l: string): string => labelOf(locale, LEVEL_KEYS, l);
export const visibilityOptions = (locale: Locale): Option[] => Object.keys(VISIBILITY_KEYS).map((v) => [v, visibilityLabel(locale, v)]);
/** Options for the given access levels, labelled in `locale`. */
export const levelOptions = (locale: Locale, levels: readonly string[]): Option[] => levels.map((l) => [l, levelLabel(locale, l)]);

export const hiddenField = (name: string, value: string): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

/**
 * A POST form with the CSRF field; `fields` and `button` are trusted markup. `style` is the button's look (`true` is the
 * older spelling of a quiet one); `cls` classes the form itself, e.g. `stack` or `form-row` for its layout.
 */
export function form(action: string, csrf: string, fields: string, button: string, style: ButtonStyle | boolean = 'primary', cls = '', small = false, attrs = '', buttonAttrs = ''): string {
  const look: ButtonStyle = style === true ? 'quiet' : style === false ? 'primary' : style;
  return `<form method="post" action="${esc(action)}"${cls ? ` class="${cls}"` : ''}${attrs}>${hiddenField('csrf', csrf)}${fields}<button type="submit" class="${btn(look, small)}"${buttonAttrs}>${button}</button></form>`;
}

/**
 * The question before a change that cannot be taken back: what it is about, what happens, and the word on the button. The form
 * posts `confirmed=1` with its other fields once the answer is yes.
 */
export interface Question { title: string; text: string; submit: string }

/**
 * Attributes that let the script ask `q` in a dialog before the form is sent; without the script the server asks on a page of
 * its own (`confirmPage`), so the change never happens on one click either way.
 */
export const confirmAttrs = (locale: Locale, q: Question): string =>
  ` data-confirm="${esc(q.title)}" data-confirm-text="${esc(q.text)}" data-confirm-ok="${esc(q.submit)}" data-confirm-cancel="${esc(t(locale, 'signin.cancel'))}"`;

/** Whether the form carried the answer to its question. */
export const confirmed = (body: unknown): boolean => (body as Record<string, unknown> | undefined)?.confirmed === '1';

/**
 * The page that asks `q` when a form arrives without `confirmed=1` (no script, or a form from elsewhere). Cancel comes first and is a
 * link back to `cancel`; the danger button sends the same fields again with the answer.
 */
export function confirmPage(locale: Locale, q: Question, target: { action: string; csrf: string; fields: Record<string, string>; cancel: string }, opts: PageOpts): string {
  const fields = Object.entries(target.fields).map(([k, v]) => hiddenField(k, v)).join('');
  return page(locale, q.title, messageCard(`<div class="auth-icon is-danger">${icon('alert')}</div><h1>${esc(q.title)}</h1><p>${esc(q.text)}</p>
<form method="post" action="${esc(target.action)}" class="gap-top">${hiddenField('csrf', target.csrf)}${fields}${hiddenField('confirmed', '1')}
<div class="btn-row"><a class="${btn('secondary')}" href="${esc(target.cancel)}">${esc(t(locale, 'signin.cancel'))}</a><button type="submit" class="${btn('danger')}">${esc(q.submit)}</button></div></form>`, opts), opts);
}

/**
 * `confirmPage` for the form a request came from: it posts back to the same address with the same plain-text fields (never the
 * old token or an earlier answer), so every route that asks replays its form the same way.
 */
export function questionPage(locale: Locale, q: Question, req: { body?: unknown; originalUrl: string }, csrf: string, cancel: string, opts: PageOpts): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== 'csrf' && k !== 'confirmed' && typeof v === 'string')) as Record<string, string>;
  return confirmPage(locale, q, { action: req.originalUrl.split('?')[0], csrf, fields, cancel }, opts);
}

/** The shape of an instance name for the browser's own check (`pattern`, matched whole; `-` escaped for the v flag; the length is maxlength's). */
const SLUG_PATTERN = '[a-z0-9]([a-z0-9\\-]*[a-z0-9])?';

/**
 * The name of a new instance: the rules and the address it becomes under the field (the script keeps the address in step with what
 * is typed), a free name filled in, and the browser checking the shape before anything is sent. `template` is the instance address
 * with `__slug__` where the name goes.
 */
export function slugField(locale: Locale, id: string, label: string, value: string, template: string): string {
  const address = template.replace('__slug__', value || '…');
  return `<div class="field"><label for="${esc(id)}">${esc(label)}</label><input id="${esc(id)}" name="slug" required maxlength="${MAX_SLUG_LENGTH}" pattern="${SLUG_PATTERN}" autocapitalize="none" autocomplete="off" spellcheck="false" aria-describedby="${esc(id)}-hint" data-address-template="${esc(template)}"${value ? ` value="${esc(value)}"` : ''}>
<p class="hint" id="${esc(id)}-hint">${esc(t(locale, 'instance.slugHint'))} <code data-address-for="${esc(id)}">${esc(address)}</code></p></div>`;
}

/** A labelled control in a form; `control` is trusted markup, `hint` plain text. */
export const field = (id: string, label: string, control: string, hint = ''): string =>
  `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${control}${hint ? `<p class="hint" id="${esc(id)}-hint">${esc(hint)}</p>` : ''}</div>`;

/** A control id that may be written into markup without escaping. */
const CONTROL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,100}$/;

/**
 * `html` with an error message at the control whose id is `id`: the message between the label and the control (so a button next to
 * the field stays level with it), the control marked invalid and described by the message, and focused when the page opens; the
 * values a refused form sent come back in the text fields they came from (`values` maps control ids to text; never a password).
 * A closed "get your own" panel around the control opens. Null when the page has no such control.
 */
export function withFieldError(html: string, id: string, message: string, values: Record<string, string> = {}): string | null {
  // Ids are written into the markup as they are: anything but a plain id (it may come from a request) is refused, not cleaned.
  if (!CONTROL_ID.test(id)) return null;
  const tagAt = (controlId: string): { start: number; end: number } | null => {
    const at = html.search(new RegExp(`<(input|select|textarea)\\b[^>]*\\sid="${controlId}"`));
    return at < 0 ? null : { start: at, end: html.indexOf('>', at) };
  };
  if (!tagAt(id)) return null;
  for (const [controlId, value] of Object.entries(values)) {
    if (!CONTROL_ID.test(controlId)) continue;
    const tag = tagAt(controlId);
    if (!tag || !html.startsWith('<input', tag.start) || /type="password"/.test(html.slice(tag.start, tag.end))) continue;
    const open = html.slice(tag.start, tag.end).replace(/\svalue="[^"]*"/, '') + ` value="${esc(value)}"`;
    html = html.slice(0, tag.start) + open + html.slice(tag.end);
  }
  const tag = tagAt(id)!;
  // The message first, then what described the control before (its hint), so a screen reader reads both.
  const before = /\saria-describedby="([^"]*)"/.exec(html.slice(tag.start, tag.end))?.[1] ?? (html.includes(`id="${id}-hint"`) ? `${id}-hint` : '');
  const open = html.slice(tag.start, tag.end).replace(/\s(aria-invalid|aria-describedby|autofocus)(="[^"]*")?/g, '')
    + ` aria-invalid="true" aria-describedby="${`${id}-error ${before}`.trim()}" autofocus`;
  const error = `<p class="field-error" id="${id}-error">${icon('alert', 'i-sm')}<span>${esc(message)}</span></p>`;
  html = html.slice(0, tag.start) + error + open + html.slice(tag.end);
  // The control may sit in a panel that starts closed: the "Get your own" panels of the home page, written exactly so in dashboard.ts.
  const panel = html.lastIndexOf('<details class="getown"', tag.start);
  if (panel >= 0 && html.indexOf('</details>', panel) > tag.start) html = `${html.slice(0, panel)}<details open class="getown"${html.slice(panel + '<details class="getown"'.length)}`;
  return html;
}

/** `<option>` list for a select; `options` are [value, label] pairs. */
export const optionList = (options: ReadonlyArray<Option>, selected: string): string =>
  options.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

/** Notice line above a page body; the flash carries catalog keys and is shown in `locale`. */
export const noticeHtml = (locale: Locale, flash: { ok?: MessageKey; error?: MessageKey; params?: Record<string, string> }): string =>
  (flash.ok ? notice('success', noticeText(locale, flash.ok, flash.params)) : '') + (flash.error ? notice('danger', noticeText(locale, flash.error, flash.params)) : '');

/**
 * `body` with the notice of `flash`: right above the element whose id is the flash's anchor when the body has one, so the change
 * and the word about it are on screen together after the redirect, else at the top. The notice carries the id the redirect's
 * fragment names (`#notice`).
 */
export function withNotice(locale: Locale, flash: { ok?: MessageKey; error?: MessageKey; params?: Record<string, string>; anchor?: string; undo?: { action: string; fields: Record<string, string> }; field?: string; values?: Record<string, string>; copy?: string }, body: string, csrf = ''): string {
  // An error about one field is shown at that field, with what was typed; the page needs no banner then.
  if (flash.error && flash.field) {
    const placed = withFieldError(body, flash.field, noticeText(locale, flash.error, flash.params), flash.values);
    if (placed !== null) return placed;
  }
  const undo = (flash.ok && flash.undo && csrf ? undoForm(locale, flash.undo, csrf) : '') + (flash.ok && flash.copy ? `<span class="notice-undo">${copyButton(locale, flash.copy, 'secondary', t(locale, 'instance.copyLink'))}</span>` : '');
  const html = (flash.ok ? notice('success', noticeText(locale, flash.ok, flash.params), undo) : '') + (flash.error ? notice('danger', noticeText(locale, flash.error, flash.params)) : '');
  return placeNotice(html.replace('<div class="notice', '<div id="notice" tabindex="-1" class="notice'), flash.anchor, body);
}

/** The Undo button inside a notice: a form that sends the change back. */
export const undoForm = (locale: Locale, undo: { action: string; fields: Record<string, string> }, csrf: string): string =>
  `<form method="post" action="${esc(undo.action)}" class="notice-undo">${hiddenField('csrf', csrf)}${Object.entries(undo.fields).map(([k, v]) => hiddenField(k, v)).join('')}<button type="submit" class="${btn('secondary', true)}">${esc(t(locale, 'common.undo'))}</button></form>`;

/** `html` inserted right before the element of `body` whose id is `anchor`, or at the top. */
function placeNotice(html: string, anchor: string | undefined, body: string): string {
  if (!html) return body;
  const at = anchor ? body.indexOf(` id="${anchor}"`) : -1;
  const start = at < 0 ? -1 : body.lastIndexOf('<', at);
  return start < 0 ? html + body : body.slice(0, start) + html + body.slice(start);
}

export const forbiddenInstancePage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.instance'), backLink(locale), opts, 'danger');
export const forbiddenAppPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.app'), backLink(locale), opts, 'danger');
/** A page-level "does not exist" with a way back; `what` is a catalog key. */
export const missingPage = (locale: Locale, what: MessageKey, back = backLink(locale), opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.notFound.title'), noticeText(locale, what), back, opts);
/** A form post that failed for a reason the viewer should read; `message` is a catalog key. */
export const formErrorPage = (locale: Locale, message: MessageKey, back = backLink(locale), opts: PageOpts = {}): string =>
  page(locale, t(locale, 'error.failed.title'), messageCard(`<div class="auth-icon is-danger">${icon('alert')}</div><h1>${esc(t(locale, 'error.failed.title'))}</h1>${notice('danger', noticeText(locale, message))}${back}`, opts), opts);
