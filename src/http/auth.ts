import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { MIN_PASSWORD_LENGTH, type User } from '../platform/users.js';
import { requireUser, type PlatformExtension } from './app.js';
import { sameOriginGuard } from './origin.js';
import { esc, page, resendForm, signedInHeader } from './pages.js';
import { RateLimiter } from './ratelimit.js';
import { csrfToken, csrfValid, issueSession } from './session.js';

const HOUR_MS = 3600_000;
const SHORT_PASSWORD = `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`;
const INVALID_LINK = 'Der Link ist ungültig oder abgelaufen.';
const MAX_FIELD = 300;
const MAX_TOKEN = 200;

const notice = (title: string, text: string, extra = ''): string => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}`);
const errorLine = (message?: string): string => (message ? `<p class="err" role="alert">${esc(message)}</p>` : '');

function registerForm(values: { name: string; email: string }, invite: string, bound: string | null, error?: string): string {
  return page('Konto erstellen', `<h1>Konto erstellen</h1>
${errorLine(error)}
<form method="post" action="/register">
<input type="hidden" name="invite" value="${esc(invite)}">
<label for="name">Name</label><input id="name" name="name" autocomplete="name" required maxlength="80" value="${esc(values.name)}" autofocus>
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(bound ?? values.email)}"${bound ? ' readonly' : ''}>
<label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">
<p class="muted">Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.</p>
<button type="submit">Konto erstellen</button>
</form>
<p><a href="/login">Zur Anmeldung</a></p>`);
}

const forgotForm = (): string => page('Passwort vergessen', `<h1>Passwort vergessen</h1>
<form method="post" action="/forgot">
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button type="submit">Link zum Zurücksetzen senden</button>
</form>
<p><a href="/login">Zur Anmeldung</a></p>`);

const resetForm = (token: string, error?: string): string => page('Neues Passwort', `<h1>Neues Passwort</h1>
${errorLine(error)}
<form method="post" action="/reset">
<input type="hidden" name="token" value="${esc(token)}">
<label for="password">Neues Passwort</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" autofocus>
<p class="muted">Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.</p>
<button type="submit">Passwort speichern</button>
</form>`);

const verifyForm = (token: string): string => page('E-Mail-Adresse bestätigen', `<h1>E-Mail-Adresse bestätigen</h1>
<form method="post" action="/verify">
<input type="hidden" name="token" value="${esc(token)}">
<button type="submit">E-Mail-Adresse bestätigen</button>
</form>`);

const invalidLinkPage = (): string => notice('Link ungültig', INVALID_LINK, resendForm());

function accountPage(core: Core, user: User, msg: { ok?: string; error?: string } = {}): string {
  const csrf = esc(csrfToken(core, user));
  return page('Konto', `<h1>Konto</h1>
${msg.ok ? `<p class="ok" role="status">${esc(msg.ok)}</p>` : ''}${errorLine(msg.error)}
<h2>Name</h2>
<form method="post" action="/account/name"><input type="hidden" name="csrf" value="${csrf}">
<label for="name">Name</label><input id="name" name="name" required maxlength="80" value="${esc(user.name)}" autocomplete="name">
<button type="submit">Speichern</button></form>
<h2>Passwort ändern</h2>
<form method="post" action="/account/password"><input type="hidden" name="csrf" value="${csrf}">
<label for="current">Aktuelles Passwort</label><input id="current" name="current" type="password" required autocomplete="current-password">
<label for="new-password">Neues Passwort</label><input id="new-password" name="password" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
<p class="muted">Mindestens ${MIN_PASSWORD_LENGTH} Zeichen. Danach werden alle anderen Geräte abgemeldet und alle Verbindungen zu Claude getrennt; API-Tokens bleiben gültig.</p>
<button type="submit">Passwort ändern</button></form>`, { headerExtra: signedInHeader(user.email, csrf, user.role === 'admin') });
}

/** Public account pages: registration, e-mail verification, password reset and the account page. */
export const authExtension: PlatformExtension = (router, core) => {
  const origin = core.config.publicUrl.origin;
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

  /**
   * Pages here carry one-time links: never cache them. `same-origin` keeps the URL (and its token) from leaving the origin
   * while letting browsers send the real Origin on the form posts that `sameOrigin` checks (`no-referrer` would turn it into `null`).
   */
  const hardened: RequestHandler = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
    next();
  };
  const sameOrigin = sameOriginGuard(origin);
  const publicForm = [hardened, formBody, sameOrigin];

  const tooMany = (res: Response): void => html(res, 429, notice('Zu viele Anfragen', 'Bitte warte eine Weile und versuche es später erneut.'));

  // --- registration ---

  const closedPage = (): string => notice('Registrierung', 'Die Registrierung ist geschlossen.');
  const inviteOnlyPage = (): string => notice('Registrierung', 'Registrierung nur mit Einladung.');

  router.get('/register', hardened, (req, res) => {
    const mode = core.settings.registration;
    if (mode === 'closed') { html(res, 200, closedPage()); return; }
    const token = typeof req.query.invite === 'string' ? req.query.invite.slice(0, MAX_TOKEN) : '';
    const invite = token ? core.accounts.getInvite(token) : null;
    if (!invite && mode === 'invite') { html(res, 200, inviteOnlyPage()); return; }
    html(res, 200, registerForm({ name: '', email: '' }, invite ? token : '', invite?.email ?? null,
      token && !invite ? 'Die Einladung ist ungültig oder abgelaufen.' : undefined));
  });

  // `POST /register` is also OAuth dynamic client registration (JSON, mounted by the MCP extension): leave anything but a browser form to it.
  const formOnly: RequestHandler = (req, _res, next) => { if (req.is('application/x-www-form-urlencoded')) next(); else next('route'); };
  router.post('/register', formOnly, ...publicForm, async (req, res) => {
    if (!registerIp.hit(ipOf(req))) { tooMany(res); return; }
    const mode = core.settings.registration;
    if (mode === 'closed') { html(res, 403, closedPage()); return; }
    const token = field(req, 'invite', MAX_TOKEN);
    const values = { name: field(req, 'name'), email: field(req, 'email', 254) };
    if (!token && mode === 'invite') { html(res, 403, inviteOnlyPage()); return; }
    const bound = token ? core.accounts.getInvite(token)?.email ?? null : null;
    const again = (status: number, error: string): void => html(res, status, registerForm(values, token, bound, error));
    if (field(req, 'password').length < MIN_PASSWORD_LENGTH) { again(400, SHORT_PASSWORD); return; }
    try {
      const { user, needsVerification } = await core.accounts.register({
        name: values.name, email: values.email, password: field(req, 'password'), inviteToken: token || undefined,
      });
      if (needsVerification) {
        html(res, 200, notice('Fast geschafft', 'Wir haben dir eine E-Mail geschickt. Bestätige deine Adresse über den Link darin.'));
        return;
      }
      issueSession(core, res, user);
      res.redirect('/');
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      if (e.code === 'conflict') again(409, 'Diese E-Mail-Adresse ist bereits registriert.');
      else again(e.code === 'forbidden' ? 403 : 400, e.message);
    }
  });

  // --- e-mail verification ---

  // Showing the form consumes nothing: a link opened by a mail scanner or by the wrong person verifies and signs in nobody.
  router.get('/verify', hardened, (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : '';
    if (!core.accounts.checkVerificationToken(token)) { html(res, 400, invalidLinkPage()); return; }
    html(res, 200, verifyForm(token));
  });

  router.post('/verify', ...publicForm, (req, res) => {
    try {
      core.accounts.verifyEmail(field(req, 'token', MAX_TOKEN));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      html(res, 400, invalidLinkPage());
      return;
    }
    // No session is issued: whoever clicked the link proved the mailbox, not the password.
    res.redirect('/login?verified=1');
  });

  router.post('/verify/resend', ...publicForm, async (req, res) => {
    if (!resendIp.hit(ipOf(req))) { tooMany(res); return; }
    if (resendEmail.hit(emailKey(req))) await core.accounts.resendVerification(field(req, 'email', 254));
    html(res, 200, notice('E-Mail gesendet', 'Falls die Adresse bei uns registriert und noch nicht bestätigt ist, haben wir eine neue E-Mail geschickt.'));
  });

  // --- password reset ---

  router.get('/forgot', hardened, (_req, res) => { html(res, 200, forgotForm()); });

  router.post('/forgot', ...publicForm, async (req, res) => {
    if (!forgotIp.hit(ipOf(req))) { tooMany(res); return; }
    // Over the per-address budget the request is skipped without any visible difference.
    if (forgotEmail.hit(emailKey(req))) await core.accounts.requestPasswordReset(field(req, 'email', 254));
    html(res, 200, notice('E-Mail gesendet', 'Falls die Adresse bei uns registriert ist, haben wir eine E-Mail zum Zurücksetzen geschickt.'));
  });

  // Showing the form consumes nothing, so link scanners that open the URL do not burn the token.
  router.get('/reset', hardened, (req, res) => {
    html(res, 200, resetForm(typeof req.query.token === 'string' ? req.query.token.slice(0, MAX_TOKEN) : ''));
  });

  router.post('/reset', ...publicForm, (req, res) => {
    const token = field(req, 'token', MAX_TOKEN);
    const password = field(req, 'password');
    try {
      core.accounts.resetPassword(token, password);
      html(res, 200, notice('Passwort zurückgesetzt', 'Passwort geändert. Alle Verbindungen zu Claude und alle API-Tokens dieses Kontos wurden widerrufen.', '<p><a href="/login">Zur Anmeldung</a></p>'));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      // The token is judged before the password, so any other complaint is about the password and keeps the form.
      html(res, 400, e.message === INVALID_LINK ? invalidLinkPage() : resetForm(token, SHORT_PASSWORD));
    }
  });

  // --- account page ---

  const auth = requireUser(core);
  const userOf = (res: Response): User => res.locals.user as User;
  const accountAction = (run: (req: Request, res: Response, user: User) => void): RequestHandler[] => [
    hardened, auth, formBody,
    (req, res) => {
      const user = userOf(res);
      if (!csrfValid(core, user, field(req, 'csrf', 2000))) {
        html(res, 403, page('Fehler', '<h1>Das hat nicht geklappt</h1><p class="err">Die Sitzung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.</p><p><a href="/account">Zurück zum Konto</a></p>'));
        return;
      }
      run(req, res, user);
    },
  ];

  router.get('/account', hardened, auth, (_req, res) => { html(res, 200, accountPage(core, userOf(res))); });

  router.post('/account/name', ...accountAction((req, res, user) => {
    try {
      const updated = core.users.setName(user.id, field(req, 'name'));
      html(res, 200, accountPage(core, updated, { ok: 'Name gespeichert.' }));
    } catch (e) {
      if (!(e instanceof LagerError)) throw e;
      html(res, 400, accountPage(core, user, { error: 'Der Name muss 1 bis 80 Zeichen lang sein.' }));
    }
  }));

  router.post('/account/password', ...accountAction((req, res, user) => {
    if (!passwordTries.hit(user.id)) {
      html(res, 429, accountPage(core, user, { error: 'Zu viele Versuche. Bitte warte einige Minuten.' }));
      return;
    }
    if (!core.users.checkLogin(user.email, field(req, 'current')).ok) {
      html(res, 400, accountPage(core, user, { error: 'Das aktuelle Passwort ist falsch.' }));
      return;
    }
    if (field(req, 'password').length < MIN_PASSWORD_LENGTH) {
      html(res, 400, accountPage(core, user, { error: SHORT_PASSWORD }));
      return;
    }
    passwordTries.reset(user.id);
    core.users.setPassword(user.id, field(req, 'password'));
    // setPassword moved the epoch on, ending every other session; this browser gets a fresh one.
    const fresh = core.users.get(user.id)!;
    issueSession(core, res, fresh);
    html(res, 200, accountPage(core, fresh, { ok: 'Passwort geändert.' }));
  }));
};
