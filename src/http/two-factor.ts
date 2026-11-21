import crypto from 'node:crypto';
import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { t, type Locale } from '../i18n/index.js';
import { MAX_CODE_INPUT, otpauthUri, RECOVERY_CODE_COUNT, SETUP_TTL_MS, TOTP_DIGITS, type CodeCheck } from '../platform/two-factor.js';
import type { User } from '../platform/users.js';
import { addressKey } from './client-address.js';
import { clearCookie, cookieRepeated, readCookie, setCookie, twoFactorCookieName } from './cookies.js';
import { safeReturnPath } from './errors.js';
import { requestLocale } from './locale.js';
import { sameOriginGuard } from './origin.js';
import { authCard, esc, field, hiddenField, loginPage, page } from './pages.js';
import { RateLimiter } from './ratelimit.js';
import { epochValid, issueSession, markDevice } from './session.js';
import { signToken, verifyToken } from './tokens.js';
import { btn, copyButton, copyField, icon, notice, signedIn } from './ui.js';

/** Time between the right password and the code; after it the password has to be entered again. */
export const SECOND_STEP_TTL_SECONDS = 5 * 60;
/** Codes one sign-in may try before the password has to be entered again. The account-wide count in `TwoFactor` comes on top. */
export const MAX_CODES_PER_SIGN_IN = 3;
/** Codes one client address may send to the second step in `CODE_WINDOW_MS`, whichever accounts they are for. */
export const MAX_CODES_PER_ADDRESS = 30;
const CODE_WINDOW_MS = 15 * 60_000;

interface PendingToken { uid?: unknown; k?: unknown; ep?: unknown; p?: unknown; jti?: unknown; r?: unknown }
export interface SecondStep { user: User; returnPath: string; id: string }

/**
 * Called instead of `issueSession` when the password was right and the account has two-step sign-in on. The cookie names the
 * account, its session epoch and password, and where to go afterwards; it is worth nothing once the password changes or the
 * account signs out everywhere, and expires after `SECOND_STEP_TTL_SECONDS`.
 */
export function beginSecondStep(core: Core, res: Response, user: User, returnPath: string): void {
  const token = signToken({
    uid: user.id, k: '2fa', ep: user.sessionEpoch, p: core.users.passwordMark(user.id), jti: crypto.randomUUID(), r: safeReturnPath(returnPath),
  }, core.config.secret, SECOND_STEP_TTL_SECONDS);
  setCookie(res, core.config, twoFactorCookieName(core.config), token, SECOND_STEP_TTL_SECONDS);
}

/** The sign-in this browser is in the middle of, or null when it has none that is still good. A cookie sent twice counts as none. */
export function pendingSecondStep(core: Core, req: Request): SecondStep | null {
  const name = twoFactorCookieName(core.config);
  if (cookieRepeated(req, name)) return null;
  const tok = verifyToken<PendingToken>(readCookie(req, name), core.config.secret);
  if (!tok || tok.k !== '2fa' || typeof tok.uid !== 'string' || typeof tok.jti !== 'string' || typeof tok.p !== 'string') return null;
  const user = core.users.get(tok.uid);
  if (!epochValid(user, tok.ep) || !user.verified || tok.p !== core.users.passwordMark(user.id) || !core.twoFactor.isEnabled(user.id)) return null;
  return { user, returnPath: safeReturnPath(tok.r), id: tok.jti };
}

const minutesUntil = (until: number): number => Math.max(1, Math.ceil((until - Date.now()) / 60_000));

/** The text for a code that was not accepted, on the sign-in page and on the account page alike. */
export function codeRefusal(locale: Locale, result: Exclude<CodeCheck, { ok: true }>): string {
  return result.reason === 'locked' ? t(locale, 'twoFactor.locked', { minutes: minutesUntil(result.until) }) : t(locale, 'twoFactor.wrong');
}

/** The code field: a code from the app or, where `recovery` is set, a recovery code. */
const codeInput = (recovery: boolean, autofocus = false): string =>
  `<input id="code" name="code" required maxlength="${MAX_CODE_INPUT}" autocomplete="one-time-code" spellcheck="false" autocapitalize="off"${recovery ? '' : ` inputmode="numeric" pattern="[0-9 ]{${TOTP_DIGITS},${TOTP_DIGITS + 2}}"`}${autofocus ? ' autofocus' : ''}>`;

/** The page between the password and the session. */
function secondStepPage(locale: Locale, error?: string): string {
  const title = t(locale, 'login.twoFactor.title');
  return page(locale, title, `${authCard(`<div class="auth-icon">${icon('shield')}</div><h1>${esc(title)}</h1>
${error ? notice('danger', error) : ''}<p>${esc(t(locale, 'login.twoFactor.text'))}</p>
<form method="post" action="/login/two-factor" class="stack">
${field('code', t(locale, 'login.twoFactor.label'), codeInput(true, true), t(locale, 'login.twoFactor.recoveryHint'))}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'login.submit'))}</button>
</form>`)}<p class="auth-links"><a href="/login">${esc(t(locale, 'common.toLogin'))}</a></p>`, { switcher: false });
}

/**
 * `/login/two-factor`: the second step of signing in to an account with two-step sign-in on. Only a browser that just gave
 * the right password holds the cookie it needs. Every wrong code counts three times: against this sign-in, against the client
 * address, and against the account in the database, where it can pause the second step for everyone (see `TwoFactor.check`).
 */
export function twoFactorLoginRoutes(router: express.Router, core: Core): void {
  const { config } = core;
  const tries = new RateLimiter(MAX_CODES_PER_SIGN_IN, SECOND_STEP_TTL_SECONDS * 1000);
  // A sign-in that ended in a session cannot be finished a second time, not even with another valid code.
  const finished = new RateLimiter(1, SECOND_STEP_TTL_SECONDS * 1000);
  const byAddress = new RateLimiter(MAX_CODES_PER_ADDRESS, CODE_WINDOW_MS);
  const headers: RequestHandler = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
    next();
  };
  const html = (res: Response, status: number, body: string): void => { res.status(status).type('html').send(body); };
  const startOver = (res: Response, locale: Locale, why: 'login.twoFactor.expired' | 'login.twoFactor.again' = 'login.twoFactor.expired'): void => {
    clearCookie(res, config, twoFactorCookieName(config));
    html(res, 401, loginPage(locale, '/', t(locale, why), { registration: core.settings.registration }));
  };

  router.get('/login/two-factor', headers, (req, res) => {
    const step = pendingSecondStep(core, req);
    if (!step || finished.full(step.id) || tries.full(step.id)) { res.redirect('/login'); return; }
    html(res, 200, secondStepPage(requestLocale(core, req, step.user)));
  });

  // Same-site instance code must not be able to post a code into a sign-in of this browser.
  router.post('/login/two-factor', headers, sameOriginGuard(core), express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const step = pendingSecondStep(core, req);
    const locale = requestLocale(core, req, step?.user ?? null);
    if (!step || finished.full(step.id)) { startOver(res, locale); return; }
    if (!byAddress.hit(addressKey(req.ip))) { html(res, 429, secondStepPage(locale, t(locale, 'login.tooMany'))); return; }
    if (!tries.hit(step.id)) { startOver(res, locale, 'login.twoFactor.again'); return; }
    const code = (req.body as Record<string, unknown> | undefined)?.code;
    const result = core.twoFactor.check(step.user.id, typeof code === 'string' ? code : '');
    if (!result.ok) {
      if (result.reason === 'locked' && result.started) core.accounts.noticeTwoFactor(step.user, 'locked', locale);
      // The last try of this sign-in is spent: back to the password, which has limits of its own.
      if (tries.full(step.id) && result.reason !== 'locked') { startOver(res, locale, 'login.twoFactor.again'); return; }
      html(res, result.reason === 'locked' ? 429 : 401, secondStepPage(locale, codeRefusal(locale, result)));
      return;
    }
    finished.hit(step.id);
    clearCookie(res, config, twoFactorCookieName(config));
    if (result.method === 'recovery') core.accounts.noticeTwoFactor(step.user, 'recovery', locale, result.recoveryLeft);
    // The browser has proved the whole sign-in only now: the device cookie that exempts it from a pause comes with the session.
    issueSession(core, res, step.user);
    markDevice(core, res, step.user);
    res.redirect(step.returnPath);
  });
}

/** The product name, which is not translated. */
const BRAND = 'Lager';
/** The server's name in authenticator apps: two Lager servers in one app must be told apart. */
const issuer = (core: Core): string => `${BRAND} (${core.config.publicUrl.host})`;

/** The two-step sign-in card of the account page. */
export function twoFactorCard(core: Core, locale: Locale, user: User, csrf: string): string {
  const status = core.twoFactor.status(user.id);
  const title = `<h2>${esc(t(locale, 'account.twoFactor.title'))}</h2>`;
  const password = (id: string): string => field(id, t(locale, 'account.password.current'), `<input id="${id}" name="current" type="password" required autocomplete="current-password">`);
  if (!status.enabled) {
    return `<section class="card">${title}<p>${esc(t(locale, 'account.twoFactor.offText'))}</p>
<form method="post" action="/account/two-factor/setup" class="stack">${hiddenField('csrf', csrf)}
${password('tf-setup-current')}
<div><button type="submit" class="${btn('primary')}">${icon('shield')}${esc(t(locale, 'account.twoFactor.setupSubmit'))}</button></div></form></section>`;
  }
  const codeField = (id: string): string => field(id, t(locale, 'account.twoFactor.codeLabel'),
    `<input id="${id}" name="code" required maxlength="${MAX_CODE_INPUT}" autocomplete="one-time-code" spellcheck="false" autocapitalize="off">`);
  const action = (path: string, id: string, label: string, style: 'secondary' | 'danger'): string =>
    `<form method="post" action="${path}" class="stack gap-top">${hiddenField('csrf', csrf)}${password(`${id}-current`)}${codeField(`${id}-code`)}
<div><button type="submit" class="${btn(style)}">${esc(label)}</button></div></form>`;
  const warning = status.unreadable ? notice('warning', t(locale, 'account.twoFactor.unreadable'))
    : status.recoveryLeft <= 2 ? notice('warning', t(locale, 'account.twoFactor.recoveryLow', { count: status.recoveryLeft })) : '';
  return `<section class="card">${title}${notice('success', t(locale, 'account.twoFactor.onText'))}
<p class="hint">${esc(t(locale, 'account.twoFactor.recoveryLeft', { count: status.recoveryLeft, total: RECOVERY_CODE_COUNT }))}</p>${warning}
<details class="gap-top"><summary>${esc(t(locale, 'account.twoFactor.recoverySubmit'))}</summary>${action('/account/two-factor/recovery', 'tf-recovery', t(locale, 'account.twoFactor.recoverySubmit'), 'secondary')}</details>
<details class="gap-top"><summary>${esc(t(locale, 'account.twoFactor.disableSubmit'))}</summary>${action('/account/two-factor/disable', 'tf-disable', t(locale, 'account.twoFactor.disableSubmit'), 'danger')}</details></section>`;
}

/**
 * The form token of a setup page: issued only where the password was just given, bound to the account, its epoch and the setup now
 * pending. Without it the secret is never shown again and the setup cannot be confirmed, so somebody who holds a session but
 * not the password cannot take over a setup the owner started.
 */
export function setupToken(core: Core, user: User): string | null {
  const mark = core.twoFactor.pendingMark(user.id);
  return mark ? signToken({ uid: user.id, k: '2fa-setup', ep: user.sessionEpoch, m: mark }, core.config.secret, SETUP_TTL_MS / 1000) : null;
}

export function setupTokenValid(core: Core, user: User, value: unknown): boolean {
  const tok = verifyToken<{ uid?: unknown; k?: unknown; ep?: unknown; m?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  const mark = core.twoFactor.pendingMark(user.id);
  return tok !== null && mark !== null && tok.k === '2fa-setup' && tok.uid === user.id && tok.ep === user.sessionEpoch && tok.m === mark;
}

/** Groups of four, as authenticator apps accept them typed in. */
const grouped = (secret: string): string => secret.match(/.{1,4}/g)!.join(' ');

/** The secret of a new setup and the field for the first code from it. Never cached; the secret is not in force before that code. */
export function setupPage(core: Core, locale: Locale, user: User, csrf: string, token: string, secret: string, error?: string): string {
  const title = t(locale, 'account.twoFactor.setup.title');
  const uri = otpauthUri(secret, issuer(core), user.email);
  return page(locale, title, `<div class="narrow"><div class="page-head"><h1>${esc(title)}</h1></div>
${error ? notice('danger', error) : ''}
<section class="card"><ol class="steps stack">
<li><p>${esc(t(locale, 'account.twoFactor.setup.step1'))}</p>
<p><a class="${btn('secondary')}" href="${esc(uri)}">${icon('open')}${esc(t(locale, 'account.twoFactor.setup.open'))}</a></p>
${field('tf-key', t(locale, 'account.twoFactor.setup.key'), copyField(locale, grouped(secret)), t(locale, 'account.twoFactor.setup.keyHint'))}</li>
<li><form method="post" action="/account/two-factor/confirm" class="stack">${hiddenField('csrf', csrf)}${hiddenField('setup', token)}
${field('code', t(locale, 'account.twoFactor.setup.step2'), codeInput(false, true), t(locale, 'account.twoFactor.setup.expiry'))}
<div class="btn-row"><a class="${btn('secondary')}" href="/account">${esc(t(locale, 'signin.cancel'))}</a><button type="submit" class="${btn('primary')}">${esc(t(locale, 'account.twoFactor.setup.submit'))}</button></div></form></li>
</ol></section></div>`, signedIn(core, user, null, '/account'));
}

/** Recovery codes, shown once. */
export function recoveryCodesPage(core: Core, locale: Locale, user: User, codes: string[], ok: string): string {
  const title = t(locale, 'account.twoFactor.codes.title');
  return page(locale, title, `<div class="narrow"><div class="page-head"><h1>${esc(title)}</h1></div>${notice('success', ok)}
<section class="callout" role="status"><p>${esc(t(locale, 'account.twoFactor.codes.text'))}</p>
<ul class="recovery-codes">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>
<p>${copyButton(locale, codes.join('\n'), 'primary')}</p>
</section>
<p><a class="${btn('primary')}" href="/account">${esc(t(locale, 'account.twoFactor.codes.done'))}</a></p></div>`, signedIn(core, user, null, '/account'));
}
