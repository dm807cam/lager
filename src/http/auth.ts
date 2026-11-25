import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { isLocale, LOCALE_NAMES, LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { hashSecret } from '../platform/tokens.js';
import { MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { addressKey } from './client-address.js';
import { requestLocale } from './locale.js';
import { loginLimiter } from './platform.js';
import { sameOriginGuard } from './origin.js';
import { authCard, esc, field, messagePage, page, resendForm, sessionExpiredPage } from './pages.js';
import { avatar, btn, icon, notice as noticeBox, signedIn } from './ui.js';
import { RateLimiter } from './ratelimit.js';
import { csrfToken, csrfValid, issueSession, markDevice } from './session.js';
import { codeRefusal, recoveryCodesPage, setupPage, setupToken, setupTokenValid, twoFactorCard } from './two-factor.js';

const HOUR_MS = 3600_000;
/**
 * Accounts the whole server lets people create for themselves per hour, whatever address they come from: each one may send a
 * mail from the operator's mail account. Registrations through an invitation do not count.
 */
export const MAX_REGISTRATIONS_PER_HOUR = 30;
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

/** The form that asks for a reset mail. Used only while the server can send mail; otherwise `noMailPage` says whom to ask. */
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

/** Setting a new password through a reset link confirms the address too, so the way out of a forgotten password is offered here. */
const verifyForm = (locale: Locale, token: string, error?: string): string => page(locale, t(locale, 'auth.verify.title'), `${authCard(`<div class="auth-icon is-success">${icon('check')}</div><h1>${esc(t(locale, 'auth.verify.title'))}</h1>
${errorLine(error)}
<form method="post" action="/verify" class="stack">
<input type="hidden" name="token" value="${esc(token)}">
${field('password', t(locale, 'common.password'), '<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>', t(locale, 'auth.verify.hint'))}
<button type="submit" class="${btn('primary')}">${esc(t(locale, 'auth.verify.submit'))}</button>
</form>`)}<p class="auth-links"><a href="/forgot">${esc(t(locale, 'login.forgot'))}</a></p>`, { switcher: false });

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
<div><button type="submit" class="${btn('primary')}">${esc(t(locale, 'account.password.submit'))}</button></div></form></section>
${twoFactorCard(core, locale, user, csrfToken(core, user))}</div>`, signedIn(core, user, null, '/account'));
}

/** Public account pages: registration, e-mail verification, password reset and the account page. */
export const authExtension: PlatformExtension = (router, core) => {
  const formBody = express.urlencoded({ extended: false, limit: '10kb' });
  const registerIp = new RateLimiter(5, HOUR_MS);
  const registrations = new RateLimiter(MAX_REGISTRATIONS_PER_HOUR, HOUR_MS);
  // Notices to the owner of an address somebody else tried to register, so the form cannot be used to fill a mailbox.
  const takenEmail = new RateLimiter(3, HOUR_MS);
  const forgotIp = new RateLimiter(5, HOUR_MS);
  const forgotEmail = new RateLimiter(3, HOUR_MS);
  const resendIp = new RateLimiter(5, HOUR_MS);
  const resendEmail = new RateLimiter(3, HOUR_MS);
  // Guessing the current password through the account page needs a session already, but is still capped.
  const passwordTries = new RateLimiter(10, 15 * 60_000);
  // Codes tried against a setup that is not confirmed yet, from the browser that holds its form token.
  const setupTries = new RateLimiter(10, 15 * 60_000);
  // Wrong passwords on the confirmation form, counted per client address and per link, so changing address does not buy more guesses at one link.
  const verifyTries = new RateLimiter(10, 15 * 60_000);

  const field = (req: Request, name: string, max = MAX_FIELD): string => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  /** A password is never cut: a shortened one would be stored but never match at sign-in. Too long a one is refused where it is set. */
  const secret = (req: Request, name: string): string => field(req, name, Infinity);
  const emailKey = (req: Request): string => field(req, 'email', 254).trim().toLowerCase();
  const ipOf = (req: Request): string => addressKey(req.ip);
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

  // Without mail the form to send another confirmation link would only promise a mail that never comes.
  const invalidLinkPage = (locale: Locale): string =>
    notice(locale, t(locale, 'auth.link.invalid.title'), t(locale, 'auth.link.invalid'), core.mailer.enabled ? resendForm(locale) : `<p class="hint gap-top">${esc(t(locale, 'auth.resend.noMail'))}</p>${toLogin(locale)}`);
  /**
   * What a page that would send mail says on a server that sends none: whom to ask instead. The same text for every address, so it
   * tells nothing about which accounts exist.
   */
  const noMailPage = (locale: Locale, key: 'auth.forgot.noMail' | 'auth.resend.noMail'): string =>
    notice(locale, t(locale, key === 'auth.forgot.noMail' ? 'auth.forgot.title' : 'auth.register.pageTitle'), t(locale, key), toLogin(locale));

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
    // A registration that ends in "check your mail": an open one, or one through an invitation that names no address.
    const mailed = core.mailer.enabled && !bound;
    const sent = (): void => html(res, 200, notice(locale, t(locale, 'auth.register.sent.title'), t(locale, 'auth.register.sent.text'), toLogin(locale)));
    if (secret(req, 'password').length < MIN_PASSWORD_LENGTH) { again(400, t(locale, 'auth.password.short', { min: MIN_PASSWORD_LENGTH })); return; }
    if (mailed && core.accounts.mailBudgetSpent('account')) { tooMany(req, res); return; }
    // The place in this hour's registrations is taken before the password is hashed, and given back if nothing comes of it:
    // of many requests sent at once, no more than the cap get through.
    const counted = !token;
    if (counted && !registrations.hit('all')) { tooMany(req, res); return; }
    try {
      const { user, needsVerification } = await core.accounts.register({
        name: values.name, email: values.email, password: secret(req, 'password'), inviteToken: token || undefined, locale,
      });
      if (needsVerification) { sent(); return; }
      issueSession(core, res, user);
      markDevice(core, res, user);
      res.redirect('/');
    } catch (e) {
      // A taken address keeps its place where it is answered like a new one: otherwise the cap would tell the two apart.
      if (counted && !(e instanceof LagerError && e.reason === 'email_taken' && mailed)) registrations.release('all');
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'rate_limited') { tooMany(req, res); return; }
      // Where a new account would be told to check its mail, a taken address gets the same answer, and its owner a mail instead:
      // the form does not say which addresses have an account. Without mail there is no other way to tell the visitor.
      if (e.reason === 'email_taken' && mailed) {
        if (takenEmail.hit(emailKey(req))) core.accounts.noticeExistingAccount(values.email, locale);
        sent();
        return;
      }
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
  router.post('/verify', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    const token = field(req, 'token', MAX_TOKEN);
    const keys = [`ip:${ipOf(req)}`, `link:${hashSecret(token)}`];
    if (keys.some((k) => verifyTries.full(k))) { tooMany(req, res); return; }
    // Counted before the password is checked, so guesses sent at once cannot all slip under the limit; taken back unless it was wrong.
    for (const k of keys) verifyTries.hit(k);
    const uncount = (): void => { for (const k of keys) verifyTries.release(k); };
    let user: User;
    try {
      user = await core.accounts.verifyEmail(token, secret(req, 'password'));
    } catch (e) {
      // Only a wrong password counts, as at sign-in: confirming many accounts from one address is not guessing.
      if (!(e instanceof LagerError && e.reason === 'password_wrong')) uncount();
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'rate_limited') { tooMany(req, res); return; }
      if (e.reason !== 'password_wrong') { html(res, 400, invalidLinkPage(locale)); return; }
      html(res, 400, verifyForm(locale, token, t(locale, 'auth.verify.wrong')));
      return;
    }
    uncount();
    // No session is issued here: signing in stays the one place that does, with its own limits. The browser that held both the
    // link and the password is remembered, so a pause of the account does not keep it out.
    markDevice(core, res, user);
    res.redirect('/login?verified=1');
  });

  router.post('/verify/resend', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    if (!resendIp.hit(ipOf(req)) || core.accounts.mailBudgetSpent('account')) { tooMany(req, res); return; }
    if (!core.mailer.enabled) { html(res, 200, noMailPage(locale, 'auth.resend.noMail')); return; }
    if (resendEmail.hit(emailKey(req))) await core.accounts.resendVerification(field(req, 'email', 254), locale);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.resend.sent.text'), toLogin(locale)));
  });

  // --- password reset ---

  router.get('/forgot', hardened, (req, res) => {
    const locale = localeOf(req);
    html(res, 200, core.mailer.enabled ? forgotForm(locale) : noMailPage(locale, 'auth.forgot.noMail'));
  });

  router.post('/forgot', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    // A paused account (a name that is paused, whether an account of that name exists or not) gets its reset mail even when this
    // hour's reset mails are spent: the mail is the owner's way back in, and whoever attacks the account may be draining the budget too.
    const paused = loginLimiter(core).accountPaused(emailKey(req));
    if (!forgotIp.hit(ipOf(req)) || (!paused && core.accounts.mailBudgetSpent('reset'))) { tooMany(req, res); return; }
    if (!core.mailer.enabled) { html(res, 200, noMailPage(locale, 'auth.forgot.noMail')); return; }
    // Over the per-address budget the request is skipped without any visible difference.
    if (forgotEmail.hit(emailKey(req))) await core.accounts.requestPasswordReset(field(req, 'email', 254), locale, paused);
    html(res, 200, notice(locale, t(locale, 'auth.mailSent.title'), t(locale, 'auth.forgot.sent'), toLogin(locale)));
  });

  // Showing the form consumes nothing, so link scanners that open the URL do not burn the token.
  router.get('/reset', hardened, (req, res) => {
    html(res, 200, resetForm(localeOf(req), typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : ''));
  });

  router.post('/reset', ...publicForm, async (req, res) => {
    const locale = localeOf(req);
    const token = field(req, 'token', MAX_TOKEN);
    const password = secret(req, 'password');
    try {
      const user = await core.accounts.resetPassword(token, password);
      // Whoever set the password through the link from the mailbox is the owner: this browser is known from now on, so an attack
      // on the account that goes on does not pause it here again.
      markDevice(core, res, user);
      html(res, 200, notice(locale, t(locale, 'auth.reset.done.title'), t(locale, 'auth.reset.done'), toLogin(locale)));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'rate_limited') { tooMany(req, res); return; }
      // The token is judged before the password, so any other complaint is about the password and keeps the form.
      html(res, 400, e.reason === 'link_invalid' ? invalidLinkPage(locale) : resetForm(locale, token, reasonText(locale, e)));
    }
  });

  // --- account page ---

  const auth = requireUser(core);
  const userOf = (res: Response): User => res.locals.user as User;
  const accountAction = (run: (req: Request, res: Response, user: User, locale: Locale) => void | Promise<void>): RequestHandler[] => [
    hardened, auth, formBody,
    async (req, res) => {
      const user = userOf(res);
      const locale = requestLocale(core, req, user);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) {
        html(res, 403, sessionExpiredPage(locale, '/account', t(locale, 'account.back')));
        return;
      }
      try {
        await run(req, res, user, locale);
      } catch (e) {
        // Too many passwords are being checked at once.
        if (!(e instanceof LagerError) || e.code !== 'rate_limited') throw e;
        html(res, 429, accountPage(core, locale, user, { error: t(locale, 'account.tooMany') }));
      }
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

  router.post('/account/password', ...accountAction(async (req, res, user, locale) => {
    if (!passwordTries.hit(user.id)) {
      html(res, 429, accountPage(core, locale, user, { error: t(locale, 'account.tooMany') }));
      return;
    }
    if (!(await core.users.checkLogin(user.email, secret(req, 'current'), true)).ok) {
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
    await core.users.setPassword(user.id, password);
    // setPassword moved the epoch on, ending every other session; this browser gets a fresh one.
    const fresh = core.users.get(user.id)!;
    issueSession(core, res, fresh);
    markDevice(core, res, fresh);
    html(res, 200, accountPage(core, locale, fresh, { ok: t(locale, 'account.password.changed') }));
  }));

  // --- two-step sign-in ---

  /**
   * The current password, checked under the same limit as on the password form. Every change to two-step sign-in asks for it:
   * a session left open on someone else's computer must not be enough to turn it off or to read new recovery codes.
   */
  const passwordConfirmed = async (req: Request, res: Response, user: User, locale: Locale): Promise<boolean> => {
    if (!passwordTries.hit(user.id)) {
      html(res, 429, accountPage(core, locale, user, { error: t(locale, 'account.tooMany') }));
      return false;
    }
    if (!(await core.users.checkLogin(user.email, secret(req, 'current'), true)).ok) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'account.password.wrong') }));
      return false;
    }
    passwordTries.reset(user.id);
    return true;
  };

  /** A code from the app or a recovery code, counted against the account like one at sign-in. */
  const codeConfirmed = (req: Request, res: Response, user: User, locale: Locale): boolean => {
    const result = core.twoFactor.check(user.id, field(req, 'code', 100));
    if (result.ok) {
      if (result.method === 'recovery') core.accounts.noticeTwoFactor(user, 'recovery', locale, result.recoveryLeft);
      return true;
    }
    if (result.reason === 'locked' && result.started) core.accounts.noticeTwoFactor(user, 'locked', locale);
    html(res, result.reason === 'locked' ? 429 : 400, accountPage(core, locale, user, { error: codeRefusal(locale, result) }));
    return false;
  };

  router.post('/account/two-factor/setup', ...accountAction(async (req, res, user, locale) => {
    const alreadyOn = (): boolean => {
      if (!core.twoFactor.isEnabled(user.id)) return false;
      html(res, 409, accountPage(core, locale, user, { error: t(locale, 'account.twoFactor.alreadyOn') }));
      return true;
    };
    if (alreadyOn()) return;
    if (!(await passwordConfirmed(req, res, user, locale))) return;
    // Another tab may have confirmed a setup while the password was being checked; `startSetup` would refuse with a conflict.
    if (alreadyOn()) return;
    const secretKey = core.twoFactor.startSetup(user.id);
    html(res, 200, setupPage(core, locale, user, csrfToken(core, user), setupToken(core, user)!, secretKey));
  }));

  router.post('/account/two-factor/confirm', ...accountAction((req, res, user, locale) => {
    const pending = core.twoFactor.pendingSecret(user.id);
    // Only the browser that gave the password holds the token: anyone else sees neither the secret nor a way to confirm it.
    const token = field(req, 'setup', 2000);
    if (!pending || !setupTokenValid(core, user, token)) {
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'account.twoFactor.expired') }));
      return;
    }
    if (!setupTries.hit(user.id)) {
      html(res, 429, setupPage(core, locale, user, csrfToken(core, user), token, pending, t(locale, 'account.tooMany')));
      return;
    }
    let codes: string[];
    try {
      codes = core.twoFactor.confirmSetup(user.id, field(req, 'code', 100));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      if (e.reason === 'two_factor_code_wrong') {
        html(res, 400, setupPage(core, locale, user, csrfToken(core, user), token, pending, t(locale, 'twoFactor.wrong')));
        return;
      }
      html(res, 400, accountPage(core, locale, user, { error: t(locale, 'account.twoFactor.expired') }));
      return;
    }
    setupTries.reset(user.id);
    // Every other way into the account was opened with the password alone: sessions in other browsers, codes for instances,
    // connected assistants and API tokens end now, as after a new password. This browser, which just proved both, gets a fresh session.
    core.users.bumpEpoch(user.id);
    core.oauth.revokeUser(user.id);
    core.tokens.revokeAll(user.id);
    const fresh = core.users.get(user.id)!;
    issueSession(core, res, fresh);
    markDevice(core, res, fresh);
    core.accounts.noticeTwoFactor(fresh, 'enabled', locale);
    html(res, 200, recoveryCodesPage(core, locale, fresh, codes, t(locale, 'account.twoFactor.codes.enabled')));
  }));

  router.post('/account/two-factor/recovery', ...accountAction(async (req, res, user, locale) => {
    if (!core.twoFactor.isEnabled(user.id)) { html(res, 409, accountPage(core, locale, user)); return; }
    if (!(await passwordConfirmed(req, res, user, locale)) || !codeConfirmed(req, res, user, locale)) return;
    const codes = core.twoFactor.regenerateRecoveryCodes(user.id);
    // New codes are a lasting way in that needs no app: the owner hears about it, as about every other change.
    core.accounts.noticeTwoFactor(user, 'renewed', locale);
    html(res, 200, recoveryCodesPage(core, locale, user, codes, t(locale, 'account.twoFactor.codes.renewed')));
  }));

  router.post('/account/two-factor/disable', ...accountAction(async (req, res, user, locale) => {
    if (!core.twoFactor.isEnabled(user.id)) { html(res, 409, accountPage(core, locale, user)); return; }
    if (!(await passwordConfirmed(req, res, user, locale)) || !codeConfirmed(req, res, user, locale)) return;
    core.twoFactor.disable(user.id);
    core.accounts.noticeTwoFactor(user, 'disabled', locale);
    html(res, 200, accountPage(core, locale, user, { ok: t(locale, 'account.twoFactor.disabled') }));
  }));
};
