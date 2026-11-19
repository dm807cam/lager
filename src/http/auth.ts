import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { isLocale, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { requestLocale } from './locale.js';
import { sameOriginGuard } from './origin.js';
import { authCard, esc, field, messagePage, page, resendForm, sessionExpiredPage } from './pages.js';
import { avatar, btn, icon, notice as noticeBox, signedIn } from './ui.js';
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
  password_long: 'auth.password.long',
  link_invalid: 'auth.link.invalid',
};
const reasonText = (locale: Locale, e: LagerError): string =>
  t(locale, REASON_KEYS[e.reason ?? ''] ?? 'validation.generic', { min: MIN_PASSWORD_LENGTH, max: MAX_NAME_LENGTH, limit: MAX_PASSWORD_LENGTH });

const notice = (locale: Locale, title: string, text: string, extra = ''): string => messagePage(locale, title, text, extra);
const errorLine = (message?: string): string => (message ? noticeBox('danger', message) : '');
const passwordHint = (locale: Locale): string => t(locale, 'auth.password.hint', { min: MIN_PASSWORD_LENGTH });
const toLogin = (locale: Locale): string => `<p class="auth-links"><a href="/login">${esc(t(locale, 'common.toLogin'))}</a></p>`;

function registerForm(locale: Locale, values: { name: string; email: string }, invite: string, bound: string | null, error?: string): string {
  const title = t(locale, 'auth.register.title');
  return page(locale, title, `${authCard(`<h1>${esc(title)}</h1>
${errorLine(error)}
<form method="post" action="/register" class="stack">
<input type="hidden" name="invite" value="${esc(invite)}">
${field('name', t(locale, 'common.name'), `<input id="name" name="name" autocomplete="name" required maxlength="${MAX_NAME_LENGTH}" value="${esc(values.name)}" autofocus>`)}
${field('email', t(locale, 'common.email'), `<input id="email" name="email" type="email" autocomplete="email" required value="${esc(bound ?? values.email)}"${bound ? ' readonly' : ''}>`)}
${field('password', t(locale, 'common.password'), `<input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">`, passwordHint(locale))}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'auth.register.submit'))}</button>
</form>`)}${toLogin(locale)}`, { ...(invite ? { switcher: false } : { returnPath: '/register' }) });
}

const forgotForm = (locale: Locale): string => page(locale, t(locale, 'auth.forgot.title'), `${authCard(`<h1>${esc(t(locale, 'auth.forgot.title'))}</h1>
<form method="post" action="/forgot" class="stack">
${field('email', t(locale, 'common.email'), '<input id="email" name="email" type="email" autocomplete="email" required autofocus>')}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'auth.forgot.submit'))}</button>
</form>`)}${toLogin(locale)}`, { returnPath: '/forgot' });

/** The reset, verify and invited-register pages carry a one-time token: they offer no language switcher, because the switcher's link would put the token into a `/lang` URL; the cookie or browser language applies. */
const resetForm = (locale: Locale, token: string, error?: string): string => page(locale, t(locale, 'auth.reset.title'), authCard(`<h1>${esc(t(locale, 'auth.reset.title'))}</h1>
${errorLine(error)}
<form method="post" action="/reset" class="stack">
<input type="hidden" name="token" value="${esc(token)}">
${field('password', t(locale, 'auth.reset.label'), `<input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" autofocus>`, passwordHint(locale))}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'auth.reset.submit'))}</button>
</form>`), { switcher: false });

const verifyForm = (locale: Locale, token: string, error?: string): string => page(locale, t(locale, 'auth.verify.title'), authCard(`<div class="auth-icon is-success">${icon('check')}</div><h1>${esc(t(locale, 'auth.verify.title'))}</h1>
${errorLine(error)}
<form method="post" action="/verify" class="stack">
<input type="hidden" name="token" value="${esc(token)}">
${field('password', t(locale, 'common.password'), '<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>', t(locale, 'auth.verify.hint'))}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'auth.verify.submit'))}</button>
</form>`), { switcher: false });

const invalidLinkPage = (locale: Locale): string => notice(locale, t(locale, 'auth.link.invalid.title'), t(locale, 'auth.link.invalid'), resendForm(locale));

function accountPage(core: Core, locale: Locale, user: User, msg: { ok?: string; error?: string } = {}): string {
  const csrf = esc(csrfToken(core, user));
  const choices = [['', t(locale, 'account.locale.browser')], ...LOCALES.map((l) => [l, LOCALE_NAMES[l]])];
  const options = choices.map(([value, label]) => `<option value="${esc(value)}"${value === (user.locale ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const save = `<button type="submit" class="${btn('secondary')}">${esc(t(locale, 'common.save'))}</button>`;
  return page(locale, t(locale, 'account.title'), `<div class="narrow"><div class="page-head account-head">${avatar(user, 'lg')}<div><h1>${esc(t(locale, 'account.title'))}</h1><p class="lede">${esc(user.email)}</p></div></div>
${msg.ok ? noticeBox('success', msg.ok) : ''}${errorLine(msg.error)}
<section class="card"><h2>${esc(t(locale, 'account.profile'))}</h2>
<form method="post" action="/account/name" class="form-row"><input type="hidden" name="csrf" value="${csrf}">
${field('name', t(locale, 'common.name'), `<input id="name" name="name" required maxlength="${MAX_NAME_LENGTH}" value="${esc(user.name)}" autocomplete="name">`)}
${save}</form>
<form method="post" action="/account/locale" class="form-row gap-top"><input type="hidden" name="csrf" value="${csrf}">
${field('locale', t(locale, 'account.locale.label'), `<select id="locale" name="locale">${options}</select>`)}
${save}</form></section>
<section class="card"><h2>${esc(t(locale, 'account.password.title'))}</h2>
<form method="post" action="/account/password" class="stack"><input type="hidden" name="csrf" value="${csrf}">
${field('current', t(locale, 'account.password.current'), '<input id="current" name="current" type="password" required autocomplete="current-password">')}
${field('new-password', t(locale, 'auth.reset.label'), `<input id="new-password" name="password" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">`, t(locale, 'account.password.hint', { min: MIN_PASSWORD_LENGTH }))}
<div><button type="submit" class="${btn('primary')}">${esc(t(locale, 'account.password.submit'))}</button></div></form></section></div>`, signedIn(core, user, null, '/account'));
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
  // The confirmation form checks a password as well.
  const verifyTries = new RateLimiter(10, 15 * 60_000);

  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  /** A password is never cut: a shortened one would be stored but never match at sign-in. Too long a one is refused where it is set. */
  const secret = (req: Request, name: string): string => field(req, name, Infinity);
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

  const closedPage = (locale: Locale): string => notice(locale, t(locale, 'auth.register.pageTitle'), t(locale, 'auth.register.closed'), toLogin(locale));
  const inviteOnlyPage = (locale: Locale): string => notice(locale, t(locale, 'auth.register.pageTitle'), t(locale, 'auth.register.inviteOnly'), toLogin(locale));

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
    if (secret(req, 'password').length < MIN_PASSWORD_LENGTH) { again(400, t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH })); return; }
    try {
      const { user, needsVerification } = await core.accounts.register({
        name: values.name, email: values.email, password: secret(req, 'password'), inviteToken: token || undefined, locale,
      });
      if (needsVerification) {
        html(res, 200, notice(locale, t(locale, 'auth.register.sent.title'), t(locale, 'auth.register.sent.text'), toLogin(locale)));
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

  // The link proves the mailbox, the password proves who registered: only both together confirm the account.
  router.post('/verify', ...publicForm, (req, res) => {
    const locale = localeOf(req);
    const token = field(req, 'token', MAX_TOKEN);
    if (!verifyTries.hit(ipOf(req))) { tooMany(req, res); return; }
    try {
      core.accounts.verifyEmail(token, secret(req, 'password'));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      html(res, 400, e.reason === 'password_wrong' ? verifyForm(locale, token, t(locale, 'auth.verify.wrong')) : invalidLinkPage(locale));
      return;
    }
    // No session is issued here: signing in stays the one place that does, with its own limits.
    res.redirect('/login?verified=1');
  });

  router.post('/verify/resend', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!resendIp.hit(ipOf(req))) { tooMany(req, res); return; }
    if (resendEmail.hit(emailKey(req))) await core.accounts.resendVerification(field(req, 'email', 254), locale);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.resend.sent.text'), toLogin(locale)));
  });

  // --- password reset ---

  router.get('/forgot', hardened, (req, res) => { html(res, 200, forgotForm(localeOf(req))); });

  router.post('/forgot', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!forgotIp.hit(ipOf(req))) { tooMany(req, res); return; }
    // Over the per-address budget the request is skipped without any visible difference.
    if (forgotEmail.hit(emailKey(req))) await core.accounts.requestPasswordReset(field(req, 'email', 254), locale);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.forgot.sent'), toLogin(locale)));
  });

  // Showing the form consumes nothing, so link scanners that open the URL do not burn the token.
  router.get('/reset', hardened, (req, res) => {
    html(res, 200, resetForm(localeOf(req), typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : ''));
  });

  router.post('/reset', ...publicForm, (req, res) => {
    const locale = localeOf(req);
    const token = field(req, 'token', MAX_TOKEN);
    const password = secret(req, 'password');
    try {
      core.accounts.resetPassword(token, password);
      html(res, 200, notice(locale, t(locale, 'auth.reset.done.title'), t(locale, 'auth.reset.done'), toLogin(locale)));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      // The token is judged before the password, so any other complaint is about the password and keeps the form.
      html(res, 400, e.reason === 'link_invalid' ? invalidLinkPage(locale) : resetForm(locale, token, reasonText(locale, e)));
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
    if (!core.users.checkLogin(user.email, secret(req, 'current')).ok) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'account.password.wrong') }));
      return;
    }
    const password = secret(req, 'password');
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      const error = password.length < MIN_PASSWORD_LENGTH
        ? t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH }) : t(locale, 'auth.password.long', { limit: MAX_PASSWORD_LENGTH });
      html(res, 400, accountPage(core, locale, user, { error }));
      return;
    }
    passwordTries.reset(user.id);
    core.users.setPassword(user.id, password);
    // setPassword moved the epoch on, ending every other session; this browser gets a fresh one.
    const fresh = core.users.get(user.id)!;
    issueSession(core, res, fresh);
    html(res, 200, accountPage(core, locale, fresh, { ok: t(locale, 'account.password.changed') }));
  }));
};
