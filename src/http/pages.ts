import { MAX_SLUG_LENGTH } from '../config.js';
import { MAX_NAME as MAX_GROUP_NAME } from '../platform/groups.js';
import { MAX_NAME as MAX_TOKEN_NAME } from '../platform/tokens.js';
import { formatDate, formatSize, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `:root{--bg:#f6f7fb;--surface:#fff;--text:#1b1f33;--muted:#5a6178;--border:#d5d9e6;--navy:#1f2a5c;--accent:#f58220;--on-accent:#1f2a5c;--link:#1f2a5c;--err:#b00020;--ok:#0b6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#10142b;--surface:#1a2040;--text:#e8eaf6;--muted:#a3a9c6;--border:#343c6b;--link:#ffb067;--err:#ff8a9b;--ok:#6fdc9f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
header.top{background:var(--navy);color:#fff}
header.top .in{max-width:60rem;margin:0 auto;padding:.6rem 1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
header.top img{width:40px;height:40px;border-radius:10px;display:block}
header.top .name{font-size:1.25rem;font-weight:700;letter-spacing:.02em}
header.top .who{margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:.4rem .75rem;font-size:.9rem;min-width:0}
header.top form{margin:0}
header.top a.nav{color:#fff}
main{max-width:24rem;margin:2rem auto;padding:0 1rem}
main.wide{max-width:60rem}
h1{font-size:1.5rem;margin:0 0 1rem}h2{font-size:1.2rem;margin:2rem 0 .75rem}h3{font-size:1rem;margin:1rem 0 .4rem}
a{color:var(--link)}
label{display:block;margin:1rem 0 .25rem}
input,select{font:inherit;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);max-width:100%}
main:not(.wide) input{width:100%}
button{font:inherit;font-weight:600;padding:.45rem .9rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
button.quiet{background:transparent;color:inherit;border:1px solid currentColor;font-weight:400}
header.top button.quiet{color:#fff}
nav.tabs{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin:0 0 1rem;border-bottom:1px solid var(--border)}
nav.tabs a{padding:.4rem .2rem;text-decoration:none;border-bottom:3px solid transparent}
nav.tabs a.current{border-bottom-color:var(--accent);font-weight:600}
form.inline{margin:0;display:flex;gap:.5rem;align-items:center}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
main:not(.wide) button{margin-top:1.25rem}
.err{color:var(--err)}.ok{color:var(--ok)}.muted{color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem;margin:0 0 1rem}
.card h3:first-child{margin-top:0}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.row form{margin:0;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.35rem .5rem .35rem 0;border-bottom:1px solid var(--border);vertical-align:middle}
.scroll{overflow-x:auto}
code,.mono{font-family:ui-monospace,monospace;font-size:.9em;word-break:break-all}
footer.lang{max-width:60rem;margin:2rem auto;padding:0 1rem 2rem;font-size:.9rem}
footer.lang a.current{font-weight:700}
.pitch{margin-top:2rem}
.token{display:block;padding:.6rem;background:var(--bg);border:1px dashed var(--accent);border-radius:6px;margin:.5rem 0}`;

export interface PageOpts {
  wide?: boolean;
  headerExtra?: string;
  /** Where the language switcher sends the visitor back to (a local path); the start page when left out. */
  returnPath?: string;
  /** Instance hosts do not share the platform's language cookie, so their pages carry no switcher. */
  switcher?: boolean;
}

/** Footer with one link per language; `GET /lang/<locale>` stores the choice and redirects to `returnPath`. */
function languageSwitcher(locale: Locale, returnPath: string): string {
  const links = LOCALES.map((l) =>
    `<a href="/lang/${l}?return=${encodeURIComponent(returnPath)}" lang="${l}" hreflang="${l}"${l === locale ? ' aria-current="true" class="current"' : ''}>${esc(LOCALE_NAMES[l])}</a>`).join(' ');
  return `<footer class="lang"><nav aria-label="${esc(t(locale, 'footer.language'))}"><span class="muted">${esc(t(locale, 'footer.language'))}:</span> ${links}</nav></footer>`;
}

/** Shared shell: header with icon and name, optional `headerExtra` on the right, footer language switcher, favicon. */
export function page(locale: Locale, title: string, body: string, opts: PageOpts = {}): string {
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/webp" href="/icon.webp">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><meta name="theme-color" content="#1f2a5c">
<style>${CSS}</style></head>
<body><header class="top"><div class="in"><img src="/icon.webp" alt="" width="40" height="40"><span class="name">Lager</span>${opts.headerExtra ?? ''}</div></header>
<main${opts.wide ? ' class="wide"' : ''}>${body}</main>${opts.switcher === false ? '' : languageSwitcher(locale, opts.returnPath ?? '/')}</body></html>`;
}

/** Page with one heading and one line of text. */
export const messagePage = (locale: Locale, title: string, text: string, extra = '', opts: PageOpts = {}): string =>
  page(locale, title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}`, opts);

/** Resend form shown wherever an unverified address needs a new confirmation link. */
export const resendForm = (locale: Locale, email = ''): string => `<form method="post" action="/verify/resend">
<label for="resend-email">${esc(t(locale, 'common.email'))}</label><input id="resend-email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
<button type="submit" class="quiet">${esc(t(locale, 'auth.resend.button'))}</button>
</form>`;

export function loginPage(locale: Locale, returnPath: string, error?: string, opts: { registration?: 'open' | 'invite' | 'closed'; resendEmail?: string; notice?: string } = {}): string {
  return page(locale, t(locale, 'login.title'), `<h1>${esc(t(locale, 'brand.tagline'))}</h1>
<h2>${esc(t(locale, 'login.title'))}</h2>
${opts.notice ? `<p class="ok" role="status">${esc(opts.notice)}</p>` : ''}${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="return" value="${esc(returnPath)}">
<label for="email">${esc(t(locale, 'common.email'))}</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">${esc(t(locale, 'common.password'))}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${esc(t(locale, 'login.submit'))}</button>
</form>
${opts.resendEmail !== undefined ? resendForm(locale, opts.resendEmail) : ''}
<p><a href="/forgot">${esc(t(locale, 'login.forgot'))}</a>${opts.registration === 'closed' ? '' : ` · <a href="/register">${esc(t(locale, 'login.register'))}</a>`}</p>
<p class="muted pitch">${esc(t(locale, 'brand.pitch'))}</p>`, { returnPath: returnPath === '/' ? '/login' : `/login?return=${encodeURIComponent(returnPath)}` });
}

/** Header block of signed-in pages: navigation, the account's address and the CSRF-protected logout. */
export const signedInHeader = (locale: Locale, email: string, csrf: string, isAdmin = false): string =>
  `<div class="who"><a href="/" class="nav">${esc(t(locale, 'nav.overview'))}</a>${isAdmin ? `<a href="/admin" class="nav">${esc(t(locale, 'nav.admin'))}</a>` : ''}<a href="/account" class="nav">${esc(t(locale, 'nav.account'))}</a><span>${esc(email)}</span><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="quiet">${esc(t(locale, 'nav.signOut'))}</button></form></div>`;

export const notFoundPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.notFound.title'), t(locale, 'error.notFound.text'), '', opts);
export const forbiddenPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'error.forbidden.text'), '', opts);
export const disabledPage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.disabled.title'), t(locale, 'error.disabled.text'), '', opts);
export const badCodePage = (locale: Locale, opts: PageOpts = {}): string =>
  messagePage(locale, t(locale, 'error.badCode.title'), t(locale, 'error.badCode.text'), '', opts);
/** A form post whose CSRF token was missing or stale; `back` is the local path of the page to return to. */
export const sessionExpiredPage = (locale: Locale, back = '/', backLabel = t(locale, 'common.backToOverview')): string =>
  page(locale, t(locale, 'error.failed.title'), `<h1>${esc(t(locale, 'error.failed.title'))}</h1><p class="err">${esc(t(locale, 'error.sessionExpired'))}</p><p><a href="${esc(back)}">${esc(backLabel)}</a></p>`);

/** The administration area to anyone who is not an administrator. */
export const forbiddenAdminPage = (locale: Locale): string => messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.admin'), backLink(locale));

export const backLink = (locale: Locale, href = '/', label = t(locale, 'common.backToOverview')): string => `<p><a href="${esc(href)}">${esc(label)}</a></p>`;

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

/** OAuth consent: names the connecting client and where the browser is sent afterwards. */
export function consentPage(locale: Locale, clientName: string, redirectHost: string, userName: string, fields: Record<string, string>): string {
  return page(locale, t(locale, 'consent.title'), `<h1>${esc(t(locale, 'consent.heading'))}</h1>
<p>${emphasise(t(locale, 'consent.text', { client: CLIENT_MARK }), { [CLIENT_MARK]: clientName })}</p>
<p>${emphasise(t(locale, 'consent.signedIn', { user: userName, host: HOST_MARK }), { [HOST_MARK]: redirectHost })}</p>
<form method="post" action="/authorize">
${hidden(fields)}
<button type="submit" name="decision" value="approve">${esc(t(locale, 'consent.approve'))}</button>
<button type="submit" name="decision" value="deny">${esc(t(locale, 'consent.deny'))}</button>
</form>`, { switcher: false });
}

export const consentInvalidPage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'consent.invalid.title'), t(locale, 'consent.invalid.text'), '', { switcher: false });

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

/** A POST form with the CSRF field; `fields` and `button` are trusted markup. */
export function form(action: string, csrf: string, fields: string, button: string, quiet = false): string {
  return `<form method="post" action="${esc(action)}">${hiddenField('csrf', csrf)}${fields}<button type="submit"${quiet ? ' class="quiet"' : ''}>${button}</button></form>`;
}

/** `<option>` list for a select; `options` are [value, label] pairs. */
export const optionList = (options: ReadonlyArray<Option>, selected: string): string =>
  options.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

/** Notice line above a page body; the flash carries catalog keys and is shown in `locale`. */
export const noticeHtml = (locale: Locale, flash: { ok?: MessageKey; error?: MessageKey }): string =>
  (flash.ok ? `<p class="ok" role="status">${esc(noticeText(locale, flash.ok))}</p>` : '') + (flash.error ? `<p class="err" role="alert">${esc(noticeText(locale, flash.error))}</p>` : '');

export const forbiddenInstancePage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.instance'), backLink(locale));
export const forbiddenAppPage = (locale: Locale): string =>
  messagePage(locale, t(locale, 'error.forbidden.title'), t(locale, 'forbidden.app'), backLink(locale));
/** A page-level "does not exist" with a way back; `what` is a catalog key. */
export const missingPage = (locale: Locale, what: MessageKey, back = backLink(locale)): string =>
  messagePage(locale, t(locale, 'error.notFound.title'), noticeText(locale, what), back);
/** A form post that failed for a reason the viewer should read; `message` is a catalog key. */
export const formErrorPage = (locale: Locale, message: MessageKey, back = backLink(locale)): string =>
  page(locale, t(locale, 'error.failed.title'), `<h1>${esc(t(locale, 'error.failed.title'))}</h1><p class="err">${esc(noticeText(locale, message))}</p>${back}`);
