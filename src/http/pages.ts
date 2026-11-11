import { MAX_SLUG_LENGTH } from '../config.js';
import { MAX_NAME as MAX_GROUP_NAME } from '../platform/groups.js';
import { MAX_NAME as MAX_TOKEN_NAME } from '../platform/tokens.js';
import { formatDate, formatSize, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { staticUrls } from './static.js';
import { avatar, btn, icon, notice, SPRITE, type ButtonStyle, type IconName, type NavItem } from './ui.js';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Runs before the stylesheet applies, so a stored theme choice shows from the first paint. It only reads one value and
 * sets one attribute, and cannot throw (storage may be blocked).
 */
const THEME_SNIPPET = 'try{var t=localStorage.getItem("lager-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}';

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
  /** Whether the viewer has a catalog on the home page to jump to. */
  catalog?: boolean;
  /**
   * Origin of the platform host, for pages served on instance hosts: the stylesheet and icons are loaded from there by
   * absolute URL, and such pages get no script.
   */
  origin?: string;
  /** A larger icon above the content of a signed-out page (the sign-in page). */
  hero?: boolean;
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

const NAV: Array<{ id: NavItem; href: string; key: MessageKey; icon: IconName }> = [
  { id: 'apps', href: '/', key: 'nav.apps', icon: 'grid' },
  { id: 'catalog', href: '/#catalog', key: 'dash.catalog', icon: 'compass' },
  { id: 'publish', href: '/publish', key: 'nav.publish', icon: 'upload' },
  { id: 'admin', href: '/admin', key: 'nav.admin', icon: 'shield' },
];

/** The top bar of signed-in pages: brand, primary navigation (a tab bar on phones), language and account menus. */
function topBar(locale: Locale, opts: PageOpts, returnPath: string): { html: string; tabbar: boolean } {
  const user = opts.user!;
  const items = NAV.filter((n) => n.id === 'apps' || (n.id === 'catalog' && opts.catalog) || (n.id === 'publish' && user.publisher) || (n.id === 'admin' && user.admin));
  // A navigation with a single destination is noise: the brand already links home.
  const nav = items.length > 1 ? `<nav class="primary" aria-label="${esc(t(locale, 'nav.main'))}">${items.map((n) =>
    `<a href="${n.href}"${n.id === opts.current ? ' aria-current="page"' : ''}>${icon(n.icon)}<span>${esc(t(locale, n.key))}</span></a>`).join('')}</nav>` : '';
  const lang = opts.switcher === false ? '' : `<details class="menu lang-menu"><summary class="menu-trigger">${icon('globe', 'i-sm')}<span aria-hidden="true">${locale}</span><span class="sr-only">${esc(t(locale, 'footer.language'))}</span></summary>
<div class="menu-panel">${languageLinks(locale, returnPath, 'menu-item')}</div></details>`;
  const theme = `<button type="button" class="menu-item" data-theme-toggle data-system="${esc(t(locale, 'theme.system'))}" data-light="${esc(t(locale, 'theme.light'))}" data-dark="${esc(t(locale, 'theme.dark'))}" hidden>${icon('sun')}<span>${esc(t(locale, 'theme.label'))}: <span data-theme-name>${esc(t(locale, 'theme.system'))}</span></span></button>`;
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
 * a small brand bar and a centred column. Both end in the language footer unless `switcher` is false.
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
    content = `${skip}${bar.html}<main id="main" class="page">${body}</main>${footer(locale, switcherPath)}`;
  } else {
    bodyClass = 'auth-body';
    const brand = opts.hero
      ? `<a class="brand brand-hero" href="/"><img src="/icon.webp" alt="" width="64" height="64"><span class="sr-only">Lager</span></a>`
      : `<a class="brand" href="${esc(origin || '/')}"><img src="${origin}/icon.webp" alt="" width="32" height="32"><span>Lager</span></a>`;
    content = `${skip}<header class="auth-top${opts.hero ? ' is-hero' : ''}">${brand}</header><main id="main" class="auth">${body}</main>${footer(locale, switcherPath)}`;
  }
  // Instance hosts get no script and no platform manifest: those belong to the platform host.
  const head = origin
    ? `<link rel="stylesheet" href="${origin}${css}"><link rel="icon" type="image/webp" href="${origin}/icon.webp">`
    : `<script id="theme-init">${THEME_SNIPPET}</script><link rel="stylesheet" href="${css}">
<link rel="icon" type="image/webp" href="/icon.webp">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><script src="${js}" defer></script>`;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#1f2a5c">
${head}</head>
<body class="${bodyClass}">${SPRITE}${content}</body></html>`;
}

/** Signed-out content: a card, optionally with an icon above the heading; `inner` is trusted markup. */
export const authCard = (inner: string): string => `<div class="auth-card">${inner}</div>`;

/** Page with one heading and one line of text. */
export const messagePage = (locale: Locale, title: string, text: string, extra = '', opts: PageOpts = {}, tone: 'neutral' | 'danger' | 'success' = 'neutral'): string =>
  page(locale, title, authCard(`<div class="auth-icon${tone === 'neutral' ? '' : ` is-${tone}`}">${icon(tone === 'success' ? 'check' : 'alert')}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}`), opts);

/** Resend form shown wherever an unverified address needs a new confirmation link. */
export const resendForm = (locale: Locale, email = ''): string => `<form method="post" action="/verify/resend" class="stack">
<div class="field"><label for="resend-email">${esc(t(locale, 'common.email'))}</label><input id="resend-email" name="email" type="email" autocomplete="email" required value="${esc(email)}"></div>
<button type="submit" class="${btn('secondary')}">${esc(t(locale, 'auth.resend.button'))}</button>
</form>`;

export function loginPage(locale: Locale, returnPath: string, error?: string, opts: { registration?: 'open' | 'invite' | 'closed'; resendEmail?: string; notice?: string } = {}): string {
  return page(locale, t(locale, 'login.title'), `<div class="auth-hero"><h1>${esc(t(locale, 'brand.tagline'))}</h1></div>
<div class="auth-card"><h2>${esc(t(locale, 'login.title'))}</h2>
${opts.notice ? notice('success', opts.notice) : ''}${error ? notice('danger', error) : ''}
<form method="post" action="/login" class="stack">
<input type="hidden" name="return" value="${esc(returnPath)}">
<div class="field"><label for="email">${esc(t(locale, 'common.email'))}</label><input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
<div class="field"><label for="password">${esc(t(locale, 'common.password'))}</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'login.submit'))}</button>
</form>
${opts.resendEmail !== undefined ? resendForm(locale, opts.resendEmail) : ''}</div>
<p class="auth-links"><a href="/forgot">${esc(t(locale, 'login.forgot'))}</a>${opts.registration === 'closed' ? '' : `<a href="/register">${esc(t(locale, 'login.register'))}</a>`}</p>
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
/** A form post whose CSRF token was missing or stale; `back` is the local path of the page to return to. */
export const sessionExpiredPage = (locale: Locale, back = '/', backLabel = t(locale, 'common.backToOverview')): string =>
  page(locale, t(locale, 'error.failed.title'), authCard(`<div class="auth-icon is-danger">${icon('alert')}</div><h1>${esc(t(locale, 'error.failed.title'))}</h1>${notice('danger', t(locale, 'error.sessionExpired'))}${backLink(locale, back, backLabel)}`));

export const backLink = (locale: Locale, href = '/', label = t(locale, 'common.backToOverview')): string => `<p class="auth-links"><a href="${esc(href)}">${esc(label)}</a></p>`;

/** The administration area to anyone who is not an administrator. */
export const forbiddenAdminPage = (locale: Locale): string => messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.admin'), backLink(locale), {}, 'danger');

/** Catalog texts that quote a limit; the numbers come from the constants the code enforces. */
const LIMITS: Partial<Record<MessageKey, { max: number }>> = {
  'notice.slugInvalid': { max: MAX_SLUG_LENGTH },
  'dash.tokens.nameInvalid': { max: MAX_TOKEN_NAME },
  'admin.groups.nameInvalid': { max: MAX_GROUP_NAME },
};
/** Notice and error texts: `t` plus the limits they quote. */
export const noticeText = (locale: Locale, key: MessageKey): string => t(locale, key, LIMITS[key]);

const hidden = (fields: Record<string, string>): string =>
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');

const CLIENT_MARK = '\u0001client\u0001';
const HOST_MARK = '\u0001host\u0001';
/** Catalog text with sentinel parameters: the text is escaped first, then each sentinel becomes the escaped value in bold. */
const emphasise = (text: string, marks: Record<string, string>): string =>
  Object.entries(marks).reduce((html, [mark, value]) => html.replaceAll(mark, () => `<strong>${esc(value)}</strong>`), esc(text));

/** OAuth consent: names the connecting client and where the browser is sent afterwards. Deny comes first, so Enter never approves. */
export function consentPage(locale: Locale, clientName: string, redirectHost: string, userName: string, fields: Record<string, string>): string {
  return page(locale, t(locale, 'consent.title'), authCard(`<div class="auth-icon">${icon('shield')}</div><h1>${esc(t(locale, 'consent.heading'))}</h1>
<div class="consent-who"><p>${emphasise(t(locale, 'consent.text', { client: CLIENT_MARK }), { [CLIENT_MARK]: clientName })}</p>
<p>${emphasise(t(locale, 'consent.signedIn', { user: userName, host: HOST_MARK }), { [HOST_MARK]: redirectHost })}</p></div>
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
export const dateText = (locale: Locale, iso: string): string => esc(formatDate(locale, iso));
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
export function form(action: string, csrf: string, fields: string, button: string, style: ButtonStyle | boolean = 'primary', cls = '', small = false): string {
  const look: ButtonStyle = style === true ? 'quiet' : style === false ? 'primary' : style;
  return `<form method="post" action="${esc(action)}"${cls ? ` class="${cls}"` : ''}>${hiddenField('csrf', csrf)}${fields}<button type="submit" class="${btn(look, small)}">${button}</button></form>`;
}

/** A labelled control in a form; `control` is trusted markup, `hint` plain text. */
export const field = (id: string, label: string, control: string, hint = ''): string =>
  `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${control}${hint ? `<p class="hint">${esc(hint)}</p>` : ''}</div>`;

/** `<option>` list for a select; `options` are [value, label] pairs. */
export const optionList = (options: ReadonlyArray<Option>, selected: string): string =>
  options.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

/** Notice line above a page body; the flash carries catalog keys and is shown in `locale`. */
export const noticeHtml = (locale: Locale, flash: { ok?: MessageKey; error?: MessageKey }): string =>
  (flash.ok ? notice('success', noticeText(locale, flash.ok)) : '') + (flash.error ? notice('danger', noticeText(locale, flash.error)) : '');

export const forbiddenInstancePage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.instance'), backLink(locale), {}, 'danger');
export const forbiddenAppPage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.app'), backLink(locale), {}, 'danger');
/** A page-level "does not exist" with a way back; `what` is a catalog key. */
export const missingPage = (locale: Locale, what: MessageKey, back = backLink(locale)): string =>
  messagePage(locale, t(locale, 'error.notFound.title'), noticeText(locale, what), back);
/** A form post that failed for a reason the viewer should read; `message` is a catalog key. */
export const formErrorPage = (locale: Locale, message: MessageKey, back = backLink(locale)): string =>
  page(locale, t(locale, 'error.failed.title'), authCard(`<div class="auth-icon is-danger">${icon('alert')}</div><h1>${esc(t(locale, 'error.failed.title'))}</h1>${notice('danger', noticeText(locale, message))}${back}`));
