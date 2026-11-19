import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { RequestHandler, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Core } from '../core.js';
import { consentInvalidPage, consentPage } from '../http/pages.js';
import { sessionUser } from '../http/session.js';
import { requestLocale } from '../http/locale.js';
import { signToken, verifyToken } from '../http/tokens.js';
import { hashSecret, sameHash } from '../platform/tokens.js';
import type { User, Users } from '../platform/users.js';

const CODE_TTL_S = 10 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CONSENT_TTL_S = 600;
/**
 * A registered client that holds no code and no token is forgotten this long after its last use. Three times the life of a refresh
 * token: a client that comes back shortly after its last token lapsed must still find its registration.
 */
const CLIENT_IDLE_S = 90 * 24 * 3600;
/** Longest client metadata (name, redirect addresses, …) kept for a registration, as JSON. Anyone may register a client. */
export const MAX_CLIENT_METADATA_BYTES = 8 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

interface ClientRow {
  client_id: string; secret_hash: string | null; secret_expires_at: number | null; metadata: string; issued_at: number;
}
interface CodeRow {
  code_hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string;
  scopes: string; resource: string | null; grant_id: string; used: number; expires_at: string;
}
interface TokenRow {
  token_hash: string; kind: 'access' | 'refresh'; client_id: string; user_id: string; grant_id: string;
  scopes: string; resource: string | null; used: number; expires_at: string;
}

const randomSecret = (): string => crypto.randomBytes(32).toString('base64url');
const isoIn = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();
const expired = (iso: string): boolean => iso <= new Date().toISOString();

/**
 * A private-use scheme in reverse-domain form (RFC 8252 §7.1), such as `com.example.app:`: three or more labels of letters, digits
 * and hyphens. Two labels are not enough: operating systems ship handlers of that shape (`x-apple.systempreferences:`, `vnd.youtube:`).
 */
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}:$/;
/** Other schemes a client named in docs/connecting-ai.md signs in with: Cursor's desktop app. */
const KNOWN_APP_SCHEMES = new Set(['cursor:']);

/**
 * https anywhere, http only on the loopback interface, and the private-use URI schemes of native apps, which PKCE protects.
 * Anyone can register a client, and the browser is sent to its redirect address: any other scheme (`ms-settings:`, `tel:`, `file:`…)
 * would let a link that starts on this server open whatever the operating system has registered for it.
 */
function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return (REVERSE_DOMAIN_SCHEME.test(u.protocol) || KNOWN_APP_SCHEMES.has(u.protocol)) && !u.username && !u.password;
}

/**
 * What the consent page names as the destination: the host of a web redirect, or, for an app's own scheme, the whole
 * address without query (`com.example.app:/cb`), so a scheme that looks like a domain (`chatgpt.com:`) is not shown
 * as if it were that website. The page words the two cases differently.
 */
export function redirectTarget(uri: string): { kind: 'web' | 'app'; target: string } {
  const u = new URL(uri);
  if (u.protocol === 'https:' || u.protocol === 'http:') return { kind: 'web', target: u.host };
  return { kind: 'app', target: `${u.protocol}${u.host ? '//' + u.host : ''}${u.pathname}` };
}

/** Persistence for OAuth clients, authorization codes and tokens. Codes and tokens are stored as SHA-256 only. */
export class OAuthStore {
  constructor(private db: DatabaseSync, private users: Users) {}

  // ---- clients ---------------------------------------------------------

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    if (!client.redirect_uris.length || !client.redirect_uris.every(redirectUriAllowed)) {
      throw new InvalidClientMetadataError('redirect_uris must use https, http on localhost, or a private-use scheme of a native app in reverse-domain form (com.example.app:/callback).');
    }
    const { client_id, client_secret, client_secret_expires_at, client_id_issued_at, ...metadata } = client;
    if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_CLIENT_METADATA_BYTES) {
      throw new InvalidClientMetadataError(`Client metadata must not exceed ${MAX_CLIENT_METADATA_BYTES} bytes.`);
    }
    this.db
      .prepare('INSERT INTO oauth_clients (client_id, secret_hash, secret_expires_at, metadata, issued_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(client_id, client_secret ? hashSecret(client_secret) : null, client_secret_expires_at ?? null,
        JSON.stringify(metadata), client_id_issued_at ?? Math.floor(Date.now() / 1000), new Date().toISOString());
    this.purge();
    return client;
  }

  /**
   * Notes that the client is in use: when its consent page is shown and whenever a code or token is issued to it. The purge
   * measures idleness from here, so an assistant that kept its registration and connects again after a long time is not deleted
   * between the consent page and the answer.
   */
  touchClient(clientId: string): void {
    this.db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(new Date().toISOString(), clientId);
  }

  /** Client information without any secret; client authentication happens in `clientAuthentication`. */
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.metadata) as Omit<OAuthClientInformationFull, 'client_id'>),
      client_id: row.client_id, client_id_issued_at: row.issued_at,
      ...(row.secret_expires_at !== null ? { client_secret_expires_at: row.secret_expires_at } : {}),
    };
  }

  /** `unknown` client, `ok`, or `invalid` (secret missing, wrong or expired for a confidential client). */
  authenticateClient(clientId: string, secret: unknown): 'unknown' | 'ok' | 'invalid' {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
    if (!row) return 'unknown';
    if (row.secret_hash === null) return 'ok';
    if (typeof secret !== 'string' || !sameHash(row.secret_hash, hashSecret(secret))) return 'invalid';
    if (row.secret_expires_at && row.secret_expires_at < Math.floor(Date.now() / 1000)) return 'invalid';
    return 'ok';
  }

  // ---- codes -----------------------------------------------------------

  issueCode(input: {
    clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: string[]; resource?: URL;
  }): string {
    this.touchClient(input.clientId);
    const code = randomSecret();
    this.db
      .prepare(`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, grant_id, used, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(hashSecret(code), input.clientId, input.userId, input.redirectUri, input.codeChallenge, input.scopes.join(' '),
        input.resource?.href ?? null, crypto.randomUUID(), isoIn(CODE_TTL_S), new Date().toISOString());
    // Only after the insert: a purge must never run between a request being accepted and its own row being written.
    this.purge();
    return code;
  }

  /**
   * Marks the code used and returns it, or null if it is unknown, expired or already used.
   * A second use revokes everything issued from the first (RFC 6749 §4.1.2).
   */
  consumeCode(code: string): CodeRow | null {
    const hash = hashSecret(code);
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash) as CodeRow | undefined;
    if (!row) return null;
    const changes = Number(this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(hash).changes);
    if (changes === 0) {
      this.revokeGrant(row.grant_id);
      return null;
    }
    return expired(row.expires_at) ? null : row;
  }

  // ---- tokens ----------------------------------------------------------

  issueTokens(clientId: string, userId: string, grantId: string, scopes: string, resource: string | null): OAuthTokens {
    this.touchClient(clientId);
    const access = randomSecret();
    const refresh = randomSecret();
    const now = new Date().toISOString();
    const insert = this.db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, grant_id, scopes, resource, used, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
    insert.run(hashSecret(access), 'access', clientId, userId, grantId, scopes, resource, isoIn(ACCESS_TTL_S), now);
    insert.run(hashSecret(refresh), 'refresh', clientId, userId, grantId, scopes, resource, isoIn(REFRESH_TTL_S), now);
    this.purge();
    return {
      access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh,
      ...(scopes ? { scope: scopes } : {}),
    };
  }

  /** Rotates a refresh token. Presenting an already rotated token revokes the whole grant. */
  rotateRefreshToken(clientId: string, refreshToken: string, scopes?: string[]): OAuthTokens {
    const hash = hashSecret(refreshToken);
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash) as TokenRow | undefined;
    if (!row || row.client_id !== clientId || expired(row.expires_at)) throw new InvalidGrantError('Invalid refresh token.');
    if (row.used) {
      this.revokeGrant(row.grant_id);
      throw new InvalidGrantError('Invalid refresh token.');
    }
    const granted = row.scopes ? row.scopes.split(' ') : [];
    if (scopes?.some((s) => s && !granted.includes(s))) throw new InvalidScopeError('Requested scope exceeds the original grant.');
    if (!this.users.get(row.user_id)) throw new InvalidGrantError('Invalid refresh token.');
    this.db.prepare('UPDATE oauth_tokens SET used = 1 WHERE token_hash = ?').run(hash);
    return this.issueTokens(clientId, row.user_id, row.grant_id, row.scopes, row.resource);
  }

  verifyAccessToken(token: string): { user: User; clientId: string; scopes: string[]; expiresAt: number; resource: string | null } | null {
    if (typeof token !== 'string' || token === '' || token.length > 200) return null;
    const hash = hashSecret(token);
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(hash) as TokenRow | undefined;
    if (!row || !sameHash(row.token_hash, hash) || row.used || expired(row.expires_at)) return null;
    const user = this.users.get(row.user_id);
    if (!user || user.disabled) return null;
    return {
      user, clientId: row.client_id, scopes: row.scopes ? row.scopes.split(' ') : [],
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000), resource: row.resource,
    };
  }

  /** RFC 7009: revoking a refresh token ends the grant; unknown tokens and other clients' tokens are ignored. */
  revokeToken(clientId: string, token: string): void {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(hashSecret(token)) as TokenRow | undefined;
    if (!row || row.client_id !== clientId) return;
    if (row.kind === 'refresh') this.revokeGrant(row.grant_id);
    else this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(row.token_hash);
  }

  /** Drops every authorization code and access/refresh token of the account (password change, reset, disabling). */
  revokeUser(userId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId);
  }

  private revokeGrant(grantId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(grantId);
  }

  private purge(): void {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
    // Registering needs no account, so clients nobody finished connecting, or stopped using, must not pile up.
    this.db.prepare(`DELETE FROM oauth_clients WHERE COALESCE(last_used_at, created_at) <= ?
      AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`)
      .run(new Date(Date.now() - CLIENT_IDLE_S * 1000).toISOString());
  }
}

// ---- provider ------------------------------------------------------------

/** Binds a consent form to exactly one authorization request. */
function requestHash(clientId: string, params: AuthorizationParams): string {
  const canonical = JSON.stringify([
    clientId, params.redirectUri, params.codeChallenge, params.state ?? '', (params.scopes ?? []).join(' '), params.resource?.href ?? '',
  ]);
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** The authorization request as form/query fields (what the SDK's authorize handler parses). */
function requestFields(clientId: string, params: AuthorizationParams): Record<string, string> {
  const scope = (params.scopes ?? []).join(' ');
  return {
    response_type: 'code', client_id: clientId, redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge, code_challenge_method: 'S256',
    ...(params.state !== undefined ? { state: params.state } : {}),
    ...(scope ? { scope } : {}),
    ...(params.resource ? { resource: params.resource.href } : {}),
  };
}

/** A redirect Lager itself decided on: to the sign-in page, or to the client once the person has answered the consent page. */
function sendOn(res: Response, url: string): void {
  res.locals.oauthRedirect = url;
  res.redirect(302, url);
}

/**
 * Runs before the SDK's `/authorize` handler. That handler answers a faulty request (a wrong `response_type`, a missing challenge,
 * a foreign `resource`) by redirecting the browser to the client's registered address, before anyone signed in or saw the consent
 * page. Anyone can register a client, so that would turn a link on this server into a redirect to wherever its author likes.
 * Here every redirect the handler makes on its own becomes an error page; only those of `sendOn` leave.
 */
export function authorizeGuard(core: Core): RequestHandler {
  return (req, res, next) => {
    const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
    res.redirect = ((...args: [string] | [number, string]): void => {
      const url = args[args.length - 1] as string;
      if (res.locals.oauthRedirect === url) redirect(302, url);
      else res.status(400).type('html').send(consentInvalidPage(requestLocale(core, req, sessionUser(core, req))));
    }) as Response['redirect'];
    next();
  };
}

export class LagerOAuthProvider implements OAuthServerProvider {
  /** PKCE is verified in `exchangeAuthorizationCode`, after the code has been burned, so a failed attempt also uses it up. */
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private core: Core) {
    const store = core.oauth;
    this.clientsStore = {
      getClient: (id) => store.getClient(id),
      registerClient: (client) => store.registerClient(client as OAuthClientInformationFull),
    };
  }

  /** The protected resource is `<origin>/mcp`; Lager treats the whole platform origin as one audience, so a requested resource must live on it. */
  private checkResource(resource: URL | undefined): void {
    if (resource && resource.origin !== this.core.config.publicUrl.origin) {
      throw new InvalidTargetError('Unknown resource.');
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req;
    const { config } = this.core;
    const fields = requestFields(client.client_id, params);
    const user = sessionUser(this.core, req);
    if (!user) {
      const back = req.method === 'GET' ? req.originalUrl : `/authorize?${new URLSearchParams(fields).toString()}`;
      sendOn(res, `/login?return=${encodeURIComponent(back)}`);
      return;
    }
    this.checkResource(params.resource);
    const q = requestHash(client.client_id, params);
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });

    if (req.method !== 'POST') {
      this.core.oauth.touchClient(client.client_id);
      const csrf = signToken({ uid: user.id, k: 'consent', q, ep: user.sessionEpoch }, config.secret, CONSENT_TTL_S);
      res.type('html').send(consentPage(requestLocale(this.core, req, user), client.client_name || client.client_id, redirectTarget(params.redirectUri), user.name || user.email,
        { ...fields, csrf }));
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const t = verifyToken<{ uid?: unknown; k?: unknown; q?: unknown; ep?: unknown }>(typeof body.csrf === 'string' ? body.csrf : undefined, config.secret);
    // Like a form token, the consent token is worth nothing after a sign-out or a password change.
    if (!t || t.k !== 'consent' || t.uid !== user.id || t.q !== q || t.ep !== user.sessionEpoch) {
      res.status(403).type('html').send(consentInvalidPage(requestLocale(this.core, req, user)));
      return;
    }
    const target = new URL(params.redirectUri);
    if (body.decision === 'approve') {
      const code = this.core.oauth.issueCode({
        clientId: client.client_id, userId: user.id, redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge, scopes: params.scopes ?? [], resource: params.resource,
      });
      target.searchParams.set('code', code);
    } else {
      target.searchParams.set('error', 'access_denied');
    }
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    sendOn(res, target.href);
  }

  async challengeForAuthorizationCode(): Promise<string> {
    // Not used: skipLocalPkceValidation is set and PKCE is checked during the exchange.
    throw new InvalidGrantError('Invalid authorization code.');
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, authorizationCode: string, codeVerifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.core.oauth.consumeCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code.');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match.');
    if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      throw new InvalidGrantError('code_verifier does not match the challenge.');
    }
    const computed = Buffer.from(crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
    const expected = Buffer.from(row.code_challenge);
    if (computed.length !== expected.length || !crypto.timingSafeEqual(computed, expected)) {
      throw new InvalidGrantError('code_verifier does not match the challenge.');
    }
    this.checkResource(resource);
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource does not match.');
    if (!this.core.users.get(row.user_id)) throw new InvalidGrantError('Invalid authorization code.');
    return this.core.oauth.issueTokens(client.client_id, row.user_id, row.grant_id, row.scopes, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    return this.core.oauth.rotateRefreshToken(client.client_id, refreshToken, scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.core.oauth.verifyAccessToken(token);
    if (!info) throw new InvalidTokenError('Invalid access token.');
    return {
      token, clientId: info.clientId, scopes: info.scopes, expiresAt: info.expiresAt,
      ...(info.resource ? { resource: new URL(info.resource) } : {}), extra: { userId: info.user.id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.core.oauth.revokeToken(client.client_id, request.token);
  }
}

/**
 * Client authentication for /token and /revoke, run before the SDK handlers.
 * The SDK compares client secrets in plain text; Lager stores only their hash, so confidential
 * clients are authenticated here (client_secret_post or HTTP Basic) and the clients store never
 * hands a secret to the SDK.
 */
export function clientAuthentication(core: Core): RequestHandler[] {
  return [
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res, next) => {
      if (req.method !== 'POST') { next(); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const auth = req.get('authorization');
      if (auth && /^basic /i.test(auth)) {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        const i = decoded.indexOf(':');
        let id = '';
        let secret = '';
        try {
          id = decodeURIComponent(decoded.slice(0, i < 0 ? undefined : i).replace(/\+/g, ' '));
          secret = i < 0 ? '' : decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' '));
        } catch { /* rejected below */ }
        if (!id || (body.client_id !== undefined && body.client_id !== id)) {
          res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials.' });
          return;
        }
        body.client_id = id;
        body.client_secret = secret;
        req.body = body;
      }
      if (typeof body.client_id !== 'string') { next(); return; }
      if (core.oauth.authenticateClient(body.client_id, body.client_secret) === 'invalid') {
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials.' });
        return;
      }
      next();
    },
  ];
}
