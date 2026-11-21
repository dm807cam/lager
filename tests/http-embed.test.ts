import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { signToken } from '../src/http/tokens.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { checkCapabilities } from '../src/mcp/tools.js';
import { checkApp } from '../src/platform/check.js';
import { EMBED_LIMITS, embedDeclared, parseEmbed, siteGuess } from '../src/platform/embed.js';
import type { User } from '../src/platform/users.js';
import { DB_RATE } from '../src/http/instance.js';
import { makeHarness, type Harness, type HarnessOptions } from './support/http.js';

let h: Harness;
afterEach(() => { h?.core.close(); h = undefined as unknown as Harness; });

const C = 'comments.apps.localhost';
const O = 'other.apps.localhost';
const BLOG = 'https://myblog.example.org';
const en = (key: MessageKey): string => esc(t('en', key));

/**
 * Publisher `p` owns `comments`, a public instance of an app that declares `embed`; `m` manages it, `c` contributes to it, `u`
 * has nothing to do with it. `other` is a second embeddable instance of `p` on the same server.
 */
async function setup(caps: object = { embed: {} }, opts: HarnessOptions = {}) {
  h = makeHarness({ ...opts, extensions: [dashboardExtension, manageExtension] });
  const mk = (email: string): User => h.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role: email.startsWith('p') ? 'publisher' : 'user' });
  const [p, m, c, u] = [mk('p@x.y'), mk('m@x.y'), mk('c@x.y'), mk('u@x.y')];
  const inst = h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>c</body></html>', userId: p.id, capabilities: caps as never }).instances[0];
  h.core.apps.deploy({ slug: 'other', html: '<p>other</p>', userId: p.id, capabilities: { embed: {} } as never });
  h.core.apps.setVisibility(inst.id, 'public', p.id);
  h.core.access.setGrant(inst, 'user', m.id, 'admin', p);
  h.core.access.setGrant(inst, 'user', c.id, 'interact', p);
  const enter = async (user: User, slug = 'comments'): Promise<string> => h.enter(slug, await h.login(user.email, 'password-123'));
  return { inst, p, m, c, u, enter, pi: await enter(p), mi: await enter(m), ci: await enter(c), pc: await h.login(p.email, 'password-123') };
}

const page = (host = C) => request(h.app).get('/').set('Host', host);
const info = (cookie?: string, host = C) => { const r = request(h.app).get('/__lager/embed').set('Host', host); if (cookie) r.set('Cookie', cookie); return r; };
const put = (cookie: string | undefined, origins: unknown, opts: { header?: boolean; host?: string } = {}) => {
  const req = request(h.app).put('/__lager/embed/origins').set('Host', opts.host ?? C);
  if (cookie) req.set('Cookie', cookie);
  if (opts.header !== false) req.set('X-Lager-Request', '1');
  return req.send({ origins });
};
/** The stable reason of the error `fn` throws, or null when it does not throw. */
const reasonOf = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as { reason?: string }).reason ?? 'none'; } };

describe('embed declaration', () => {
  it('takes an empty object and nothing else, so websites can never come with a deploy', () => {
    expect(() => parseEmbed({})).not.toThrow();
    expect(() => parseEmbed({ origins: [BLOG] })).toThrow(/no field "origins"/);
    expect(() => parseEmbed(true)).toThrow(/must be an object/);
    expect(() => parseEmbed([])).toThrow(/must be an object/);
    expect(() => checkCapabilities({ embed: { origins: ['*'] } })).toThrow(/no field "origins"/);
    expect(checkCapabilities({ embed: {} })).toEqual({ embed: {} });
    expect(embedDeclared({ embed: {} })).toBe(true);
    expect(embedDeclared({ embed: { origins: [] } } as never)).toBe(false);
    expect(embedDeclared(undefined)).toBe(false);
  });

  it('is a capability check_app knows', () => {
    const html = '<script>lager.use("embed")</script>';
    expect(checkApp(html, {}).undeclared).toEqual(['embed']);
    expect(checkApp(html, { embed: {} })).toMatchObject({ unsupported: [], undeclared: [] });
  });
});

describe('frame-ancestors of an instance', () => {
  it('stays with the instance itself until its managers name a website', async () => {
    await setup();
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('names the websites the managers chose and keeps X-Frame-Options for browsers that know only that', async () => {
    const { inst } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG, 'https://www.myblog.example.org']);
    const res = await page();
    expect(res.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG} https://www.myblog.example.org`);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    h.core.embed.setOrigins(inst.id, []);
    expect((await page()).headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('opens nothing for an app that does not declare embed, even with websites stored', async () => {
    const { inst, p } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>v2</body></html>', userId: p.id });
    expect((await page()).headers['content-security-policy']).toBe("frame-ancestors 'self'");
    // The list is kept: a later version that declares embed again opens the same websites.
    h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>v3</body></html>', userId: p.id, capabilities: { embed: {} } as never });
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
  });

  it('never lets a host of this Lager frame an instance: other instances, the apps domain, the platform, custom domains', async () => {
    const { inst } = await setup();
    for (const origin of ['http://other.apps.localhost:8080', 'https://other.apps.localhost', 'http://apps.localhost', 'http://lager.localhost:8080', 'https://x.lager.localhost']) {
      expect(reasonOf(() => h.core.embed.setOrigins(inst.id, [origin])), origin).toBe('origin_lager');
    }
    const admin = h.core.users.get(h.adminId)!;
    h.core.domains.add(h.core.apps.getInstanceBySlug('other')!, 'evil.example.net', admin, true);
    expect(reasonOf(() => h.core.embed.setOrigins(inst.id, ['https://evil.example.net']))).toBe('origin_lager');
    for (const origin of ['*', 'https://*.example.org', 'myblog.example.org', 'javascript:alert(1)', `${BLOG}/path`, 42, null]) {
      expect(reasonOf(() => h.core.embed.setOrigins(inst.id, [origin])), String(origin)).toBe('origin_invalid');
    }
    expect(() => h.core.embed.setOrigins(inst.id, BLOG)).toThrow(/must be a list/);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });

  it('stops naming a website as soon as it becomes a custom domain of an instance, and it can still be removed', async () => {
    const { inst, mi } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG, 'https://notes.example.net']);
    const admin = h.core.users.get(h.adminId)!;
    h.core.domains.add(h.core.apps.getInstanceBySlug('other')!, 'notes.example.net', admin, true);
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
    expect((await info(mi)).body).toMatchObject({ origins: [BLOG, 'https://notes.example.net'], active: [BLOG] });
    // Keeping it in the list opens nothing new and is allowed; so is dropping it, from the app as well.
    expect(h.core.embed.setOrigins(inst.id, [BLOG, 'https://notes.example.net'])).toHaveLength(2);
    expect((await put(mi, [BLOG])).body.origins).toEqual([BLOG]);
  });

  it('drops a stored entry that is not exactly an origin, should the table have been changed by hand', async () => {
    const { inst } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    const db = (h.core.embed as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare('UPDATE embed_origins SET origins = ? WHERE instance_id = ?').run(JSON.stringify(['https://a;b', "https://x.example 'unsafe-inline'", BLOG, 7]), inst.id);
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
    db.prepare('UPDATE embed_origins SET origins = ? WHERE instance_id = ?').run('not json', inst.id);
    expect((await page()).headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('takes at most the limit of websites, but a list that only drops some is always taken', async () => {
    const { inst } = await setup();
    const many = Array.from({ length: EMBED_LIMITS.origins }, (_, i) => `https://site${i}.example.org`);
    expect(h.core.embed.setOrigins(inst.id, many)).toHaveLength(EMBED_LIMITS.origins);
    expect(reasonOf(() => h.core.embed.setOrigins(inst.id, [...many, 'https://one-more.example.org']))).toBe('embed_limit');
    expect(h.core.embed.setOrigins(inst.id, many.slice(1))).toHaveLength(EMBED_LIMITS.origins - 1);
  });

  it('goes with the instance', async () => {
    const { inst, p } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    h.core.apps.deleteInstance(inst.id, p.id);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });
});

describe('websites on the same site as this Lager', () => {
  it('guesses the registrable domain without the Public Suffix List', () => {
    expect(siteGuess('apps.example.com')).toBe('example.com');
    expect(siteGuess('apps.lager.fritz.box')).toBe('fritz.box');
    expect(siteGuess('apps.example.co.uk')).toBe('example.co.uk');
    expect(siteGuess('mylager.co.uk')).toBe('mylager.co.uk');
    expect(siteGuess('lager.com.br')).toBe('lager.com.br');
    expect(siteGuess('apps.localhost')).toBe('apps.localhost');
    expect(siteGuess('Apps.Example.COM.')).toBe('example.com');
    expect(siteGuess('192.168.1.10')).toBe('192.168.1.10');
  });

  it('are refused, because there the browser sends the visitor’s sign-in into the frame', async () => {
    const { inst } = await setup({ embed: {} }, { appsDomain: 'apps.example.com', publicUrl: 'http://lager.example.com:8080' });
    for (const origin of ['https://www.example.com', 'https://example.com', 'http://blog.example.com:8443']) {
      expect(reasonOf(() => h.core.embed.setOrigins(inst.id, [origin])), origin).toBe('origin_same_site');
    }
    expect(h.core.embed.setOrigins(inst.id, ['https://example.org', 'https://example.com.evil.org', 'https://notexample.com'])).toHaveLength(3);
  });

  it('cover the LAN case: apps.lager.fritz.box refuses nas.fritz.box', async () => {
    const { inst } = await setup({ embed: {} }, { appsDomain: 'apps.lager.fritz.box', publicUrl: 'http://lager.fritz.box:8080' });
    expect(reasonOf(() => h.core.embed.setOrigins(inst.id, ['http://nas.fritz.box']))).toBe('origin_same_site');
    expect(h.core.embed.setOrigins(inst.id, ['http://nas.home.arpa'])).toEqual(['http://nas.home.arpa']);
  });

  it('do not over-refuse under a country-code second level', async () => {
    const { inst } = await setup({ embed: {} }, { appsDomain: 'mylager.co.uk', publicUrl: 'http://admin.mylager.co.uk:8080' });
    expect(h.core.embed.setOrigins(inst.id, ['https://bbc.co.uk', 'https://www.blog.co.uk'])).toHaveLength(2);
    expect(reasonOf(() => h.core.embed.setOrigins(inst.id, ['https://www.mylager.co.uk']))).toBe('origin_lager');
  });

  it('stop counting when the configuration makes them same-site after they were named', async () => {
    const { inst } = await setup();
    h.core.embed.setOrigins(inst.id, ['https://blog.localhost', BLOG]);
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' https://blog.localhost ${BLOG}`);
    (h.core.config as { appsDomain: string }).appsDomain = 'apps.blog.localhost';
    expect(h.core.embed.frameAncestors(inst.id, { embed: {} })).toEqual([BLOG]);
  });
});

describe('the app can read and remove, never add', () => {
  it('a manager’s page can remove websites, but adding is refused, so the app cannot choose them', async () => {
    const { inst, mi, pi } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG, 'https://www.myblog.example.org']);
    for (const cookie of [mi, pi]) {
      const add = await put(cookie, [BLOG, 'https://www.myblog.example.org', 'https://attacker.example']);
      expect(add.status).toBe(403);
      expect(add.body.error.message).toMatch(/added on the instance page/);
    }
    // Sending a stored one in another spelling is no addition.
    expect((await put(mi, ['  https://MyBlog.example.org '])).body.origins).toEqual([BLOG]);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
    expect((await put(mi, [])).body.origins).toEqual([]);
    expect((await put(mi, ['nonsense'])).status).toBe(400);
  });

  it('tells the people who manage the instance where to add websites', async () => {
    const { mi } = await setup();
    expect((await info(mi)).body).toEqual({ origins: [], active: [], limit: EMBED_LIMITS.origins, canManage: true, manageUrl: 'http://lager.localhost:8080/instances/comments' });
  });

  it('contributors, strangers, guests and requests without the runtime header cannot change anything', async () => {
    const { inst, u, ci, mi, enter } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    const ui = await enter(u);
    for (const [who, res] of [['contributor', await put(ci, [])], ['stranger', await put(ui, [])], ['guest', await put(undefined, [])]] as const) {
      expect(res.status, who).toBe(403);
    }
    expect((await put(mi, [], { header: false })).status).toBe(403);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
  });

  it('a session for one instance is worth nothing on another, and a password change ends it', async () => {
    const { inst, p, pi } = await setup();
    const other = h.core.apps.getInstanceBySlug('other')!;
    h.core.embed.setOrigins(other.id, [BLOG]);
    // p owns "other" too, yet the cookie of "comments" signs nobody in there.
    expect((await put(pi, [], { host: O })).status).toBe(401);
    expect(h.core.embed.origins(other.id)).toEqual([BLOG]);
    h.core.embed.setOrigins(inst.id, [BLOG]);
    h.core.users.bumpEpoch(p.id);
    // The old session no longer signs anyone in: on this public instance the visitor is a guest, who may not change anything.
    expect((await put(pi, [])).status).toBe(403);
    expect((await info(pi)).body.canManage).toBe(false);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
  });

  it('counts against the viewer’s write budget', async () => {
    const { mi } = await setup();
    for (let i = 0; i < DB_RATE.writes; i++) expect((await put(mi, [])).status).toBe(200);
    const over = await put(mi, []);
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('5');
  }, 60_000);

  it('shows the websites only to the people who manage the instance', async () => {
    const { inst, ci } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    const hidden = { origins: [], active: [], limit: EMBED_LIMITS.origins, canManage: false, manageUrl: null };
    expect((await info()).body).toEqual(hidden);
    expect((await info(ci)).body).toEqual(hidden);
  });

  it('answers nobody without access on a private or users-only instance', async () => {
    const { inst, p } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    for (const visibility of ['private', 'users'] as const) {
      h.core.apps.setVisibility(inst.id, visibility, p.id);
      const res = await info();
      expect(res.status, visibility).toBe(401);
      expect(res.body.origins, visibility).toBeUndefined();
      expect((await put(undefined, [])).status, visibility).toBe(401);
    }
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
  });

  it('answers not_found for an app that does not declare embed', async () => {
    const { pi } = await setup({});
    expect((await info(pi)).status).toBe(404);
    expect((await put(pi, [])).status).toBe(404);
  });

  it('the session says the capability is there, so the runtime offers the namespace', async () => {
    await setup();
    expect((await request(h.app).get('/__lager/session').set('Host', C)).body.capabilities).toEqual({ embed: {} });
  });
});

describe('instance page: shown on other websites', () => {
  const csrf = (user: User): string => signToken({ uid: user.id, k: 'ui', ep: h.core.users.get(user.id)?.sessionEpoch }, h.core.config.secret, 3600);
  const view = (cookie: string) => request(h.app).get('/instances/comments').set('Host', h.host).set('Cookie', cookie);
  const post = (cookie: string, user: User, path: string, origin: string) =>
    request(h.app).post(`/ui/instances/comments/${path}`).set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), origin });
  const follow = async (res: request.Response, cookie: string) => (await request(h.app).get(res.headers.location).set('Host', h.host).set('Cookie', cookie)).text;

  it('lists the websites, adds one (a trailing slash is forgiven) and removes it', async () => {
    const { inst, p, pc } = await setup();
    expect((await view(pc)).text).toContain(en('instance.embed.none'));
    expect((await post(pc, p, 'embed', `${BLOG}/`)).status).toBe(302);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
    const shown = await view(pc);
    expect(shown.text).toContain(en('instance.embed.title'));
    expect(shown.text).toContain(`<span class="mono">${BLOG}</span>`);
    await post(pc, p, 'embed/remove', BLOG);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });

  it('refuses an address of this Lager with a notice', async () => {
    const { inst, p, pc } = await setup();
    expect(await follow(await post(pc, p, 'embed', 'http://other.apps.localhost:8080'), pc)).toContain(en('notice.originLager'));
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });

  it('refuses a website on the same site with a notice', async () => {
    const { inst, p, pc } = await setup({ embed: {} }, { appsDomain: 'apps.example.com', publicUrl: 'http://lager.example.com:8080' });
    expect(await follow(await post(pc, p, 'embed', 'https://www.example.com'), pc)).toContain(en('notice.originSameSite'));
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });

  it('refuses contributors, strangers, a platform administrator without a grant, and everyone on a disabled instance', async () => {
    const { inst, p, c, u, pc } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    const admin = h.core.users.get(h.adminId)!;
    const tries: Array<[string, User, string]> = [['contributor', c, await h.login(c.email, 'password-123')], ['stranger', u, await h.login(u.email, 'password-123')], ['admin without grant', admin, await h.login()]];
    for (const [who, user, cookie] of tries) {
      expect((await post(cookie, user, 'embed', 'https://attacker.example')).status, who).toBe(403);
      expect((await post(cookie, user, 'embed/remove', BLOG)).status, who).toBe(403);
    }
    h.core.apps.setInstanceDisabled(inst.id, true);
    expect((await post(pc, p, 'embed', 'https://attacker.example')).status).toBe(403);
    expect((await post(pc, p, 'embed/remove', BLOG)).status).toBe(403);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
  });

  it('has no card and takes nothing for an app without embed', async () => {
    const { inst, p, pc } = await setup();
    h.core.apps.deploy({ slug: 'comments', html: '<p>2</p>', userId: p.id });
    expect((await view(pc)).text).not.toContain(en('instance.embed.title'));
    expect((await post(pc, p, 'embed', BLOG)).status).toBe(404);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });
});
