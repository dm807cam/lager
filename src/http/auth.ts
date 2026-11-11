import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { isLocale, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH, type User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { requestLocale } from './locale.js';
import { sameOriginGuard } from './origin.js';
import { esc, messagePage, page, resendForm, sessionExpiredPage, signedInHeader } from './pages.js';
import { RateLimiter } from './ratelimit.js';
import { csrfToken, csrfValid, issueSession } from './session.js';

const HOUR_MS = 3600_000;
const MAX_FIELD = 300;
const MAX_TOKEN = 200;

/** The catalog text for each stable error reason of the account flows; anything else is a generic input error. */
const REASON_KEYS: Record<string, MessageKey> = {
  email_taken: 'auth.register.exists',
  registration_closed: 'auth.register.closed',
  invite_required: 'auth.register.inviteOnly',
  invite_invalid: 'auth.register.inviteInvalid',
  invite_email_mismatch: 'auth.register.inviteOtherEmail',
  name_invalid: 'validation.name',
  email_invalid: 'validation.email',
  password_short: 'auth.password.short',
  link_invalid: 'auth.link.invalid',
};
const reasonText = (locale: Locale, e: LagerError): string =>
  t(locale, REASON_KEYS[e.reason ?? ''] ?? 'validation.generic', { min: MIN_PASSWORD_LENGTH, max: MAX_NAME_LENGTH });

const notice = (locale: Locale, title: string, text: string, extra = ''): string => messagePage(locale, title, text, extra);
const errorLine = (message?: string): string => (message ? `<p class="err" role="alert">${esc(message)}</p>` : '');
const passwordHint = (locale: Locale): string => `<p class="muted">${esc(t(locale, 'auth.password.hint', { min: MIN_PASSWORD_LENGTH }))}</p>`;

function registerForm(locale: Locale, values: { name: string; email: string }, invite: string, bound: string | null, error?: string): string {
  const title = t(locale, 'auth.register.title');
  return page(locale, title, `<h1>${esc(title)}</h1>
${errorLine(error)}
<form method="post" action="/register">
<input type="hidden" name="invite" value="${esc(invite)}">
<label for="name">${esc(t(locale, 'common.name'))}</label><input id="name" name="name" autocomplete="name" required maxlength="${MAX_NAME_LENGTH}" value="${esc(values.name)}" autofocus>
<label for="email">${esc(t(locale, 'common.email'))}</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(bound ?? values.email)}"${bound ? ' readonly' : ''}>
<label for="password">${esc(t(locale, 'common.password'))}</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">
${passwordHint(locale)}
<button type="submit">${esc(t(locale, 'auth.register.submit'))}</button>
</form>
<p><a href="/login">${esc(t(locale, 'common.toLogin'))}</a></p>`, { ...(invite ? { switcher: false } : { returnPath: '/register' }) });
}

const forgotForm = (locale: Locale): string => page(locale, t(locale, 'auth.forgot.title'), `<h1>${esc(t(locale, 'auth.forgot.title'))}</h1>
<form method="post" action="/forgot">
<label for="email">${esc(t(locale, 'common.email'))}</label><input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button type="submit">${esc(t(locale, 'auth.forgot.submit'))}</button>
</form>
<p><a href="/login">${esc(t(locale, 'common.toLogin'))}</a></p>`, { returnPath: '/forgot' });

/** The reset, verify and invited-register pages carry a one-time token: they offer no language switcher, because the switcher's link would put the token into a `/lang` URL; the cookie or browser language applies. */
const resetForm = (locale: Locale, token: string, error?: string): string => page(locale, t(locale, 'auth.reset.title'), `<h1>${esc(t(locale, 'auth.reset.title'))}</h1>
${errorLine(error)}
<form method="post" action="/reset">
<input type="hidden" name="token" value="${esc(token)}">
<label for="password">${esc(t(locale, 'auth.reset.label'))}</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" autofocus>
${passwordHint(locale)}
<button type="submit">${esc(t(locale, 'auth.reset.submit'))}</button>
</form>`, { switcher: false });

const verifyForm = (locale: Locale, token: string): string => page(locale, t(locale, 'auth.verify.title'), `<h1>${esc(t(locale, 'auth.verify.title'))}</h1>
<form method="post" action="/verify">
<input type="hidden" name="token" value="${esc(token)}">
<button type="submit">${esc(t(locale, 'auth.verify.submit'))}</button>
</form>`, { switcher: false });

const invalidLinkPage = (locale: Locale): string => notice(locale, t(locale, 'auth.link.invalid.title'), t(locale, 'auth.link.invalid'), resendForm(locale));

function accountPage(core: Core, locale: Locale, user: User, msg: { ok?: string; error?: string } = {}): string {
  const csrf = esc(csrfToken(core, user));
  const choices = [['', t(locale, 'account.locale.browser')], ...LOCALES.map((l) => [l, LOCALE_NAMES[l]])];
  const options = choices.map(([value, label]) => `<option value="${esc(value)}"${value === (user.locale ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return page(locale, t(locale, 'account.title'), `<h1>${esc(t(locale, 'account.title'))}</h1>
${msg.ok ? `<p class="ok" role="status">${esc(msg.ok)}</p>` : ''}${errorLine(msg.error)}
<h2>${esc(t(locale, 'common.name'))}</h2>
<form method="post" action="/account/name"><input type="hidden" name="csrf" value="${csrf}">
<label for="name">${esc(t(locale, 'common.name'))}</label><input id="name" name="name" required maxlength="${MAX_NAME_LENGTH}" value="${esc(user.name)}" autocomplete="name">
<button type="submit">${esc(t(locale, 'common.save'))}</button></form>
<h2>${esc(t(locale, 'account.locale.title'))}</h2>
<form method="post" action="/account/locale"><input type="hidden" name="csrf" value="${csrf}">
<label for="locale">${esc(t(locale, 'account.locale.label'))}</label><select id="locale" name="locale">${options}</select>
<button type="submit">${esc(t(locale, 'common.save'))}</button></form>
<h2>${esc(t(locale, 'account.password.title'))}</h2>
<form method="post" action="/account/password"><input type="hidden" name="csrf" value="${csrf}">
<label for="current">${esc(t(locale, 'account.password.current'))}</label><input id="current" name="current" type="password" required autocomplete="current-password">
<label for="new-password">${esc(t(locale, 'auth.reset.label'))}</label><input id="new-password" name="password" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
<p class="muted">${esc(t(locale, 'account.password.hint', { min: MIN_PASSWORD_LENGTH }))}</p>
<button type="submit">${esc(t(locale, 'account.password.submit'))}</button></form>`, { headerExtra: signedInHeader(locale, user.email, csrf, user.role === 'admin'), returnPath: '/account' });
}

/** Public account pages: registration, e-mail verification, password reset and the account page. */
export const authExtension: PlatformExtension = (router, core) => {
  const formBody = express.urlencoded({ extended: false, limit: '10kb' });
  const registerIp = new RateLimiter(5, HOUR_MS);
  const forgotIp = new RateLimiter(5, HOUR_MS);
  const forgotEmail = new RateLimiter(3, HOUR_MS);
  const resendIp = new RateLimiter(5, HOUR_MS);
  const resendEmail = new RateLimiter(3, HOUR_MS);
  // Guessing the current password through the account page needs a session already, but is still capped.
  const passwordTries = new RateLimiter(10, 15 * 60_000);

  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const emailKey = (req: Request): string => field(req, 'email', 254).trim().toLowerCase();
  const ipOf = (req: Request): string => req.ip ?? 'unknown';
  const html = (res: Response, status: number, body: string): void => { res.status(status).type('html').send(body); };
  const localeOf = (req: Request): Locale => requestLocale(core, req);

  /**
   * Pages here carry one-time links: never cache them. `same-origin` keeps the URL (and its token) from leaving the origin
   * while letting browsers send the real Origin on the form posts that `sameOrigin` checks (`no-referrer` would turn it into `null`).
   */
  const hardened: RequestHandler = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
    next();
  };
  const sameOrigin = sameOriginGuard(core);
  const publicForm = [hardened, formBody, sameOrigin];

  const tooMany = (req: Request, res: Response): void => {
    const locale = localeOf(req);
    html(res, 429, notice(locale, t(locale, 'error.tooMany.title'), t(locale, 'error.tooMany.text')));
  };

  // --- registration ---

  const closedPage = (locale: Locale): string => notice(locale, t(locale, 'auth.register.pageTitle'), t(locale, 'auth.register.closed'));
  const inviteOnlyPage = (locale: Locale): string => notice(locale, t(locale, 'auth.register.pageTitle'), t(locale, 'auth.register.inviteOnly'));

  router.get('/register', hardened, (req, res) => {
    const locale = localeOf(req);
    const mode = core.settings.registration;
    if (mode === 'closed') { html(res, 200, closedPage(locale)); return; }
    const token = typeof req.query.invite === 'string' ? req.query.invite.slice(0, MAX_TOKEN) : '';
    const invite = token ? core.accounts.getInvite(token) : null;
    if (!invite && mode === 'invite') { html(res, 200, inviteOnlyPage(locale)); return; }
    html(res, 200, registerForm(locale, { name: '', email: '' }, invite ? token : '', invite?.email ?? null,
      token && !invite ? t(locale, 'auth.register.inviteInvalid') : undefined));
  });

  // `POST /register` is also OAuth dynamic client registration (JSON, mounted by the MCP extension): leave anything but a browser form to it.
  const formOnly: RequestHandler = (req, _res, next) => { if (req.is('application/x-www-form-urlencoded')) next(); else next('route'); };
  router.post('/register', formOnly, ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!registerIp.hit(ipOf(req))) { tooMany(req, res); return; }
    const mode = core.settings.registration;
    if (mode === 'closed') { html(res, 403, closedPage(locale)); return; }
    const token = field(req, 'invite', MAX_TOKEN);
    const values = { name: field(req, 'name'), email: field(req, 'email', 254) };
    if (!token && mode === 'invite') { html(res, 403, inviteOnlyPage(locale)); return; }
    const bound = token ? core.accounts.getInvite(token)?.email ?? null : null;
    const again = (status: number, error: string): void => html(res, status, registerForm(locale, values, token, bound, error));
    if (field(req, 'password').length < MIN_PASSWORD_LENGTH) { again(400, t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH })); return; }
    try {
      const { user, needsVerification } = await core.accounts.register({
        name: values.name, email: values.email, password: field(req, 'password'), inviteToken: token || undefined, locale,
      });
      if (needsVerification) {
        html(res, 200, notice(locale, t(locale, 'auth.register.sent.title'), t(locale, 'auth.register.sent.text')));
        return;
      }
      issueSession(core, res, user);
      res.redirect('/');
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      again(e.reason === 'email_taken' ? 409 : e.code === 'forbidden' ? 403 : 400, reasonText(locale, e));
    }
  });

  // --- e-mail verification ---

  // Showing the form consumes nothing: a link opened by a mail scanner or by the wrong person verifies and signs in nobody.
  router.get('/verify', hardened, (req, res) => {
    const locale = localeOf(req);
    const token = typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : '';
    if (!core.accounts.checkVerificationToken(token)) { html(res, 400, invalidLinkPage(locale)); return; }
    html(res, 200, verifyForm(locale, token));
  });

  router.post('/verify', ...publicForm, (req, res) => {
    try {
      core.accounts.verifyEmail(field(req, 'token', MAX_TOKEN));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      html(res, 400, invalidLinkPage(localeOf(req)));
      return;
    }
    // No session is issued: whoever clicked the link proved the mailbox, not the password.
    res.redirect('/login?verified=1');
  });

  router.post('/verify/resend', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!resendIp.hit(ipOf(req))) { tooMany(req, res); return; }
    if (resendEmail.hit(emailKey(req))) await core.accounts.resendVerification(field(req, 'email', 254), locale);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.resend.sent.text')));
  });

  // --- password reset ---

  router.get('/forgot', hardened, (req, res) => { html(res, 200, forgotForm(localeOf(req))); });

  router.post('/forgot', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!forgotIp.hit(ipOf(req))) { tooMany(req, res); return; }
    // Over the per-address budget the request is skipped without any visible difference.
    if (forgotEmail.hit(emailKey(req))) await core.accounts.requestPasswordReset(field(req, 'email', 254), locale);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.forgot.sent')));
  });

  // Showing the form consumes nothing, so link scanners that open the URL do not burn the token.
  router.get('/reset', hardened, (req, res) => {
    html(res, 200, resetForm(localeOf(req), typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : ''));
  });

  router.post('/reset', ...publicForm, (req, res) => {
    const locale = localeOf(req);
    const token = field(req, 'token', MAX_TOKEN);
    const password = field(req, 'password');
    try {
      core.accounts.resetPassword(token, password);
      html(res, 200, notice(locale, t(locale, 'auth.reset.done.title'), t(locale, 'auth.reset.done'), `<p><a href="/login">${esc(t(locale, 'common.toLogin'))}</a></p>`));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      // The token is judged before the password, so any other complaint is about the password and keeps the form.
      html(res, 400, e.reason === 'link_invalid' ? invalidLinkPage(locale) : resetForm(locale, token, t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH })));
    }
  });

  // --- account page ---

  const auth = requireUser(core);
  const userOf = (res: Response): User => res.locals.user as User;
  const accountAction = (run: (req: Request, res: Response, user: User, locale: Locale) => void): RequestHandler[] => [
    hardened, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      const locale = requestLocale(core, req, user);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) {
        html(res, 403, sessionExpiredPage(locale, '/account', t(locale, 'account.back')));
        return;
      }
      run(req, res, user, locale);
    },
  ];

  router.get('/account', hardened, auth, (req, res) => {
    const user = userOf(res);
    html(res, 200, accountPage(core, requestLocale(core, req, user), user));
  });

  router.post('/account/name', ...accountAction((req, res, user, locale) => {
    try {
      const updated = core.users.setName(user.id, field(req, 'name'));
      html(res, 200, accountPage(core, locale, updated, { ok: t(locale, 'account.name.saved') }));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'validation.name', { max: MAX_NAME_LENGTH }) }));
    }
  }));

  router.post('/account/locale', ...accountAction((req, res, user, locale) => {
    const chosen = field(req, 'locale', 10);
    if (chosen !== '' && !isLocale(chosen)) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'validation.generic') }));
      return;
    }
    const updated = core.users.setLocale(user.id, chosen === '' ? null : (chosen as Locale));
    // The page answers in the language just chosen; "browser default" falls back to what the request itself asks for.
    const now = requestLocale(core, req, updated);
    html(res, 200, accountPage(core, now, updated, { ok: t(now, 'account.locale.saved') }));
  }));

  router.post('/account/password', ...accountAction((req, res, user, locale) => {
    if (!passwordTries.hit(user.id)) {
      html(res, 429, accountPage(core, locale, user, { error: t(locale, 'account.tooMany') }));
      return;
    }
    if (!core.users.checkLogin(user.email, field(req, 'current')).ok) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'account.password.wrong') }));
      return;
    }
    if (field(req, 'password').length < MIN_PASSWORD_LENGTH) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH }) }));
      return;
    }
    passwordTries.reset(user.id);
    core.users.setPassword(user.id, field(req, 'password'));
    // setPassword moved the epoch on, ending every other session; this browser gets a fresh one.
    const fresh = core.users.get(user.id)!;
    issueSession(core, res, fresh);
    html(res, 200, accountPage(core, locale, fresh, { ok: t(locale, 'account.password.changed') }));
  }));
};
