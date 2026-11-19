import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { apiExtension } from '../src/http/api.js';
import { mcpExtension } from '../src/mcp/http.js';
import { MAX_CLIENT_METADATA_BYTES } from '../src/mcp/oauth.js';
import { makeHarness, type Harness } from './support/http.js';
import { t } from '../src/i18n/index.js';

const BASE = 'http://localhost:8080';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

function setup(): Harness {
  h = makeHarness({ publicUrl: BASE, extensions: [apiExtension, mcpExtension] });
  return h;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register(h: Harness, extra: Record<string, unknown> = {}): Promise<{ client_id: string; client_secret?: string }> {
  const res = await request(h.app).post('/register').set('Host', h.host)
    .send({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-1', ...extra,
  }).toString();
}

const unescape = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) out[unescape(m[1])] = unescape(m[2]);
  return out;
}

/** Walks authorize → consent → approve and returns the authorization code. */
async function getCode(h: Harness, cookie: string, clientId: string, challenge: string): Promise<string> {
  const page = await request(h.app).get(`/authorize?${authorizeQuery(clientId, challenge)}`).set('Host', h.host).set('Cookie', cookie);
  expect(page.status).toBe(200);
  const approve = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form')
    .send({ ...hiddenFields(page.text), decision: 'approve' });
  expect(approve.status).toBe(302);
  const loc = new URL(approve.headers.location);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-1');
  return loc.searchParams.get('code')!;
}

function exchange(h: Harness, form: Record<string, string>): request.Test {
  return request(h.app).post('/token').set('Host', h.host).type('form').send(form);
}

function initialize(h: Harness, accessToken: string): request.Test {
  return request(h.app).post('/mcp').set('Host', h.host).set('Authorization', `Bearer ${accessToken}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
}

async function fullFlow(h: Harness): Promise<{ client_id: string; tokens: Record<string, any> }> {
  const cookie = await h.login();
  const client = await register(h);
  const { verifier, challenge } = pkce();
  const code = await getCode(h, cookie, client.client_id, challenge);
  const res = await exchange(h, {
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT,
  });
  expect(res.status).toBe(200);
  return { client_id: client.client_id, tokens: res.body };
}

describe('oauth', () => {
  it('metadata documents are served', async () => {
    const h = setup();
    const as = await request(h.app).get('/.well-known/oauth-authorization-server').set('Host', h.host);
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: `${BASE}/`,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      revocation_endpoint: `${BASE}/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    // RFC 9728: the protected resource is the MCP endpoint, so its metadata lives at the path-aware location the 401 challenge names.
    const pr = await request(h.app).get('/.well-known/oauth-protected-resource/mcp').set('Host', h.host)
      .set('X-Forwarded-Host', 'evil.example').set('X-Forwarded-Proto', 'https');
    expect(pr.status).toBe(200);
    expect(pr.body).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`] });
    expect(pr.headers['access-control-allow-origin']).toBe('*');
  });

  it('native apps may register a private-use redirect scheme and complete the flow (Cursor)', async () => {
    const h = setup();
    const cookie = await h.login();
    const redirect = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const reg = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: [redirect], client_name: 'Cursor', token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    const { verifier, challenge } = pkce();
    const q = authorizeQuery(reg.body.client_id, challenge, { redirect_uri: redirect, resource: `${BASE}/mcp` });
    const consent = await request(h.app).get(`/authorize?${q}`).set('Host', h.host).set('Cookie', cookie);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('cursor://anysphere.cursor-mcp/oauth/callback');
    expect(consent.text).toContain('the app on this device');
    const approve = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form')
      .send({ ...hiddenFields(consent.text), decision: 'approve' });
    expect(approve.status).toBe(302);
    expect(approve.headers.location.startsWith(`${redirect}?`)).toBe(true);
    const code = new URL(approve.headers.location).searchParams.get('code')!;
    const res = await exchange(h, {
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: redirect, resource: `${BASE}/mcp`,
    });
    expect(res.status).toBe(200);
    expect((await initialize(h, res.body.access_token)).status).toBe(200);
  });

  it('registration refuses schemes that do not open a native app', async () => {
    const h = setup();
    for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vbscript:x', 'blob:https://x/y', 'ftp://example.com/cb',
      'myapp://user:pw@host/cb', 'cursor://x/cb#frag', 'not a uri']) {
      const res = await request(h.app).post('/register').set('Host', h.host)
        .send({ redirect_uris: [uri], token_endpoint_auth_method: 'none' });
      expect(res.status, uri).toBe(400);
    }
    const reverseDomain = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: ['com.example.app:/oauth2redirect'], token_endpoint_auth_method: 'none' });
    expect(reverseDomain.status).toBe(201);
  });

  it('full code flow with PKCE yields a token that works on /mcp', async () => {
    const h = setup();
    const { tokens } = await fullFlow(h);
    expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    const init = await initialize(h, tokens.access_token);
    expect(init.status).toBe(200);
    expect(JSON.stringify(init.body)).toContain('lager');
    // the access token also works on the REST API as the same user
    const apps = await request(h.app).get('/api/apps').set('Host', h.host).set('Authorization', `Bearer ${tokens.access_token}`);
    expect(apps.status).toBe(200);

    // nothing secret is stored in plain text
    const db = new DatabaseSync(path.join(h.core.config.dataDir, 'platform.sqlite'));
    const dump = JSON.stringify([db.prepare('SELECT * FROM oauth_tokens').all(), db.prepare('SELECT * FROM oauth_codes').all()]);
    db.close();
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });

  it('consent page names the client and the redirect host; deny redirects with access_denied', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h, { client_name: '<b>Claude</b>' });
    const page = await request(h.app).get(`/authorize?${authorizeQuery(client.client_id, pkce().challenge)}`)
      .set('Host', h.host).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('&lt;b&gt;Claude&lt;/b&gt;');
    expect(page.text).not.toContain('<b>Claude</b>');
    expect(page.text).toContain('claude.ai');
    expect(page.text).toContain(t('en', 'consent.title'));
    expect(page.headers['x-frame-options']).toBe('DENY');
    const deny = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form')
      .send({ ...hiddenFields(page.text), decision: 'deny' });
    expect(deny.status).toBe(302);
    const loc = new URL(deny.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('authorize without session redirects to /login with return', async () => {
    const h = setup();
    const client = await register(h);
    const q = authorizeQuery(client.client_id, pkce().challenge);
    const res = await request(h.app).get(`/authorize?${q}`).set('Host', h.host);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?return=${encodeURIComponent(`/authorize?${q}`)}`);
  });

  it('wrong code_verifier is rejected', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h);
    const { verifier, challenge } = pkce();
    const code = await getCode(h, cookie, client.client_id, challenge);
    const bad = await exchange(h, { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    // a failed attempt burns the code
    const retry = await exchange(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(retry.status).toBe(400);
  });

  it('code is single use', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h);
    const { verifier, challenge } = pkce();
    const code = await getCode(h, cookie, client.client_id, challenge);
    const form = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id };
    const first = await exchange(h, form);
    expect(first.status).toBe(200);
    const second = await exchange(h, form);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
    // replaying a code revokes what it issued
    expect((await initialize(h, first.body.access_token)).status).toBe(401);
  });

  it('code is bound to its client', async () => {
    const h = setup();
    const cookie = await h.login();
    const a = await register(h);
    const b = await register(h);
    const { verifier, challenge } = pkce();
    const code = await getCode(h, cookie, a.client_id, challenge);
    const res = await exchange(h, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: b.client_id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh rotates and the old refresh token stops working', async () => {
    const h = setup();
    const { client_id, tokens } = await fullFlow(h);
    const r1 = await exchange(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(r1.body.access_token).not.toBe(tokens.access_token);
    expect((await initialize(h, r1.body.access_token)).status).toBe(200);
    const old = await exchange(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id });
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('invalid_grant');
    // reuse of a rotated refresh token revokes the whole grant
    expect((await initialize(h, r1.body.access_token)).status).toBe(401);
    expect((await exchange(h, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id })).status).toBe(400);
  });

  it('refresh token is bound to its client', async () => {
    const h = setup();
    const { tokens } = await fullFlow(h);
    const other = await register(h);
    const res = await exchange(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id });
    expect(res.status).toBe(400);
  });

  it('revoke invalidates the access token', async () => {
    const h = setup();
    const { client_id, tokens } = await fullFlow(h);
    const res = await request(h.app).post('/revoke').set('Host', h.host).type('form').send({ token: tokens.access_token, client_id });
    expect(res.status).toBe(200);
    expect((await initialize(h, tokens.access_token)).status).toBe(401);
    // revoking the refresh token ends the grant
    await request(h.app).post('/revoke').set('Host', h.host).type('form').send({ token: tokens.refresh_token, client_id });
    expect((await exchange(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })).status).toBe(400);
  });

  it('consent POST without valid csrf token → 403', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h);
    const page = await request(h.app).get(`/authorize?${authorizeQuery(client.client_id, pkce().challenge)}`)
      .set('Host', h.host).set('Cookie', cookie);
    const fields = hiddenFields(page.text);
    expect(fields.csrf).toBeTruthy();
    const post = (body: Record<string, string>): request.Test =>
      request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form').send(body);

    const { csrf: _csrf, ...withoutCsrf } = fields;
    expect((await post({ ...withoutCsrf, decision: 'approve' })).status).toBe(403);
    expect((await post({ ...fields, csrf: 'x.y', decision: 'approve' })).status).toBe(403);
    // a token minted for another request (different code_challenge) does not fit
    expect((await post({ ...fields, code_challenge: pkce().challenge, decision: 'approve' })).status).toBe(403);
    // a token minted for another user does not fit
    h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw3', role: 'user' });
    const otherCookie = await h.login('u@x.y', 'pw3');
    const other = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', otherCookie).type('form')
      .send({ ...fields, decision: 'approve' });
    expect(other.status).toBe(403);
  });

  it('redirect_uri must match the registered one', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h);
    const { verifier, challenge } = pkce();
    const evil = await request(h.app).get(`/authorize?${authorizeQuery(client.client_id, challenge, { redirect_uri: 'https://evil.example/cb' })}`)
      .set('Host', h.host).set('Cookie', cookie);
    expect(evil.status).toBe(400);
    expect(evil.headers.location).toBeUndefined();

    const code = await getCode(h, cookie, client.client_id, challenge);
    const res = await exchange(h, {
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'https://evil.example/cb',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('registration refuses non-https redirect uris except loopback', async () => {
    const h = setup();
    const bad = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' });
    expect(bad.status).toBe(400);
    const loop = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: ['http://localhost:33418/callback'], token_endpoint_auth_method: 'none' });
    expect(loop.status).toBe(201);
  });

  it('confidential client must present its secret, which is stored hashed', async () => {
    const h = setup();
    const cookie = await h.login();
    const client = await register(h, { token_endpoint_auth_method: 'client_secret_post' });
    expect(typeof client.client_secret).toBe('string');
    const { verifier, challenge } = pkce();
    const code = await getCode(h, cookie, client.client_id, challenge);
    const form = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id };
    const noSecret = await exchange(h, form);
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe('invalid_client');
    const wrong = await exchange(h, { ...form, client_secret: 'nope' });
    expect(wrong.status).toBe(401);
    const ok = await exchange(h, { ...form, client_secret: client.client_secret! });
    expect(ok.status).toBe(200);

    const db = new DatabaseSync(path.join(h.core.config.dataDir, 'platform.sqlite'));
    const dump = JSON.stringify(db.prepare('SELECT * FROM oauth_clients').all());
    db.close();
    expect(dump).not.toContain(client.client_secret!);
  });

  it('a scheme that looks like a domain is shown as an app link, not as that website', async () => {
    const h = setup();
    const cookie = await h.login();
    const redirect = 'chatgpt.com:/connector_platform_oauth_redirect';
    const reg = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: [redirect], client_name: 'ChatGPT', token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    const { challenge } = pkce();
    const page = await request(h.app).get(`/authorize?${authorizeQuery(reg.body.client_id, challenge, { redirect_uri: redirect })}`)
      .set('Host', h.host).set('Cookie', cookie);
    expect(page.status).toBe(200);
    // The whole address is named, in the wording for apps on this device, never "you will be sent on to chatgpt.com:".
    expect(page.text).toContain('<strong>chatgpt.com:/connector_platform_oauth_redirect</strong>');
    expect(page.text).toContain('the app on this device');
    expect(page.text).not.toContain('you will be sent on to');
  });
});

describe('OAuth hardening', () => {
  it('redirect addresses come from an allowlist: https, http on loopback, reverse-domain schemes and the documented clients', async () => {
    const h = setup();
    const tryRegister = (uri: string) => request(h.app).post('/register').set('Host', h.host).send({ redirect_uris: [uri], token_endpoint_auth_method: 'none' });
    // Schemes the operating system hands to whatever registered them, and web schemes that are not https.
    for (const uri of ['ms-settings:display', 'tel:+4930123456', 'mailto:a@b.c', 'myapp://callback', 'vscode://vendor.ext/cb', 'zoommtg://zoom.us/join',
      'steam://run/1', 'http://example.com/cb', 'http://localhost.evil.example/cb', 'ws://localhost:1/cb', 'com.example.app://user:pw@host/cb', '.app:/cb', 'app.:/cb']) {
      expect((await tryRegister(uri)).status, uri).toBe(400);
    }
    for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/callback', 'http://127.0.0.1:5000/cb', 'http://[::1]:5000/cb',
      'com.example.app:/oauth2redirect', 'chatgpt.com:/connector_platform_oauth_redirect', 'cursor://anysphere.cursor-mcp/oauth/callback']) {
      expect((await tryRegister(uri)).status, uri).toBe(201);
    }
  });

  it('a faulty authorization request ends on an error page of the platform, never on the client address', async () => {
    const h = setup();
    const client = await register(h, { redirect_uris: ['https://evil.example/landing'] });
    const { challenge } = pkce();
    const cookie = await h.login();
    const query = (extra: Record<string, string>, drop: string[] = []): string => {
      const q = new URLSearchParams(authorizeQuery(client.client_id, challenge, { redirect_uri: 'https://evil.example/landing', ...extra }));
      for (const key of drop) q.delete(key);
      return q.toString();
    };
    const faulty = [query({ response_type: 'token' }), query({}, ['code_challenge']), query({ code_challenge_method: 'plain' }),
      query({ resource: 'not a url' }), query({ resource: 'https://other.example/mcp' })];
    for (const q of faulty) {
      for (const who of [undefined, cookie]) {
        const get = request(h.app).get(`/authorize?${q}`).set('Host', h.host);
        const res = await (who ? get.set('Cookie', who) : get);
        // A foreign resource is only looked at once somebody is signed in; before that the request leads to the sign-in page.
        if (!who && q.includes('other.example')) {
          expect(res.headers.location.startsWith('/login?return=')).toBe(true);
          continue;
        }
        expect(res.status, q).toBe(400);
        expect(res.headers.location, q).toBeUndefined();
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain(t('en', 'consent.invalid.text'));
        expect(res.text).not.toContain('evil.example');
      }
      // The same request posted from another site's form is answered the same way.
      const posted = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form').send(Object.fromEntries(new URLSearchParams(q)));
      expect(posted.status, q).toBe(400);
      expect(posted.headers.location, q).toBeUndefined();
    }
    // A sound request still leads to the sign-in page, and after the consent page the answer goes to the client as the standard says.
    const good = query({});
    const anonymous = await request(h.app).get(`/authorize?${good}`).set('Host', h.host);
    expect(anonymous.headers.location).toBe(`/login?return=${encodeURIComponent(`/authorize?${good}`)}`);
    const consent = await request(h.app).get(`/authorize?${good}`).set('Host', h.host).set('Cookie', cookie);
    expect(consent.status).toBe(200);
    for (const [decision, param] of [['deny', 'error'], ['approve', 'code']] as const) {
      const answered = await request(h.app).post('/authorize').set('Host', h.host).set('Cookie', cookie).type('form').send({ ...hiddenFields(consent.text), decision });
      expect(answered.status).toBe(302);
      const loc = new URL(answered.headers.location);
      expect(loc.origin + loc.pathname).toBe('https://evil.example/landing');
      expect(loc.searchParams.has(param)).toBe(true);
      expect(loc.searchParams.get('state')).toBe('st-1');
    }
  });

  it('registered clients that hold no code and no token are forgotten after 30 days; metadata is capped', async () => {
    const h = setup();
    const { client_id: idle } = await register(h);
    const { client_id: fresh } = await register(h);
    const { client_id: used, tokens } = await fullFlow(h);
    const db = new DatabaseSync(path.join(h.core.config.dataDir, 'platform.sqlite'));
    const age = db.prepare('UPDATE oauth_clients SET created_at = ? WHERE client_id = ?');
    const days = (n: number): string => new Date(Date.now() - n * 24 * 3600_000).toISOString();
    age.run(days(31), idle);
    age.run(days(29), fresh);
    age.run(days(400), used);
    db.close();
    // The next registration sweeps.
    await register(h);
    expect(h.core.oauth.getClient(idle)).toBeUndefined();
    expect(h.core.oauth.getClient(fresh)).toBeDefined();
    expect(h.core.oauth.getClient(used)).toBeDefined();
    expect((await initialize(h, tokens.access_token)).status).toBe(200);

    const big = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(MAX_CLIENT_METADATA_BYTES), token_endpoint_auth_method: 'none' });
    expect(big.status).toBe(400);
    expect(big.body.error).toBe('invalid_client_metadata');
    const many = await request(h.app).post('/register').set('Host', h.host)
      .send({ redirect_uris: Array.from({ length: 400 }, (_, i) => `https://example.com/callback/${i}`), token_endpoint_auth_method: 'none' });
    expect(many.status).toBe(400);
  });
});
