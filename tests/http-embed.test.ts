import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { signToken } from '../src/http/tokens.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { checkCapabilities } from '../src/mcp/tools.js';
import { checkApp } from '../src/platform/check.js';
import { EMBED_LIMITS, embedDeclared, parseEmbed } from '../src/platform/embed.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness;
afterEach(() => { h?.core.close(); });

const C = 'comments.apps.localhost';
const BLOG = 'https://blog.example.com';
const en = (key: MessageKey): string => esc(t('en', key));

/**
 * Publisher `p` owns `comments`, a public instance of an app that declares `embed`; `m` manages it, `c` contributes to it.
 * `other` is a second instance on the same server, the kind of page that must never frame `comments`.
 */
async function setup(caps: object = { embed: {} }) {
  h = makeHarness({ extensions: [dashboardExtension, manageExtension] });
  const mk = (email: string): User => h.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role: email.startsWith('p') ? 'publisher' : 'user' });
  const [p, m, c] = [mk('p@x.y'), mk('m@x.y'), mk('c@x.y')];
  const inst = h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>c</body></html>', userId: p.id, capabilities: caps as never }).instances[0];
  h.core.apps.deploy({ slug: 'other', html: '<p>other</p>', userId: p.id });
  h.core.apps.setVisibility(inst.id, 'public', p.id);
  h.core.access.setGrant(inst, 'user', m.id, 'admin', p);
  h.core.access.setGrant(inst, 'user', c.id, 'interact', p);
  const enter = async (user: User): Promise<string> => h.enter('comments', await h.login(user.email, 'password-123'));
  return { inst, p, m, c, pi: await enter(p), mi: await enter(m), ci: await enter(c), pc: await h.login(p.email, 'password-123') };
}

const page = () => request(h.app).get('/').set('Host', C);
const put = (cookie: string | undefined, origins: unknown, header = true) => {
  const req = request(h.app).put('/__lager/embed/origins').set('Host', C);
  if (cookie) req.set('Cookie', cookie);
  if (header) req.set('X-Lager-Request', '1');
  return req.send({ origins });
};

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

  it('names the websites the managers chose, and drops X-Frame-Options, which cannot list them', async () => {
    const { mi } = await setup();
    const saved = await put(mi, [BLOG, 'https://www.example.com/']);
    expect(saved.status, saved.text).toBe(400);
    expect(saved.body.error.code).toBe('invalid_argument');
    const ok = await put(mi, [BLOG, 'https://www.example.com']);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ origins: [BLOG, 'https://www.example.com'], active: [BLOG, 'https://www.example.com'], limit: EMBED_LIMITS.origins, canManage: true });
    const res = await page();
    expect(res.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG} https://www.example.com`);
    expect(res.headers['x-frame-options']).toBeUndefined();
    // An empty list closes it again.
    expect((await put(mi, [])).body.origins).toEqual([]);
    expect((await page()).headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect((await page()).headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('opens nothing for an app that does not declare embed, even with websites stored', async () => {
    const { inst, p } = await setup();
    h.core.embed.setOrigins(inst.id, [BLOG]);
    h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>v2</body></html>', userId: p.id });
    const res = await page();
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    // The list is kept: a later version that declares embed again opens the same websites.
    h.core.apps.deploy({ slug: 'comments', html: '<html><head></head><body>v3</body></html>', userId: p.id, capabilities: { embed: {} } as never });
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
  });

  it('never lets a host of this Lager frame an instance: other instances, the apps domain, the platform, custom domains', async () => {
    const { mi } = await setup();
    for (const origin of ['http://other.apps.localhost:8080', 'https://other.apps.localhost', 'http://apps.localhost', 'http://lager.localhost:8080', 'https://x.lager.localhost']) {
      const res = await put(mi, [origin]);
      expect(res.status, origin).toBe(400);
      expect(res.body.error.message, origin).toMatch(/served by this Lager/);
    }
    const admin = h.core.users.get(h.adminId)!;
    const other = h.core.apps.getInstanceBySlug('other')!;
    h.core.domains.add(other, 'evil.example.net', admin, true);
    expect((await put(mi, ['https://evil.example.net'])).status).toBe(400);
    for (const origin of ['*', 'https://*.example.com', 'blog.example.com', 'javascript:alert(1)', 'https://blog.example.com/path', 42, null]) {
      expect((await put(mi, [origin])).status, String(origin)).toBe(400);
    }
    expect((await put(mi, 'https://blog.example.com')).status).toBe(400);
  });

  it('stops naming a website as soon as it becomes a custom domain of an instance, and it can still be removed', async () => {
    const { inst, mi } = await setup();
    expect((await put(mi, [BLOG, 'https://notes.example.org'])).status).toBe(200);
    const admin = h.core.users.get(h.adminId)!;
    h.core.domains.add(h.core.apps.getInstanceBySlug('other')!, 'notes.example.org', admin, true);
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
    const info = await request(h.app).get('/__lager/embed').set('Host', C).set('Cookie', mi);
    expect(info.body).toMatchObject({ origins: [BLOG, 'https://notes.example.org'], active: [BLOG] });
    // Keeping it in the list is allowed (nothing new is opened), and so is dropping it.
    expect((await put(mi, [BLOG, 'https://notes.example.org'])).status).toBe(200);
    expect((await put(mi, [BLOG])).body.origins).toEqual([BLOG]);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
  });

  it('takes at most the limit of websites, but a list that only drops some is always taken', async () => {
    const { inst, mi } = await setup();
    const many = Array.from({ length: EMBED_LIMITS.origins }, (_, i) => `https://site${i}.example.com`);
    expect((await put(mi, many)).status).toBe(200);
    const over = await put(mi, [...many, 'https://one-more.example.com']);
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/At most 20/);
    expect((await put(mi, many.slice(1))).status).toBe(200);
    expect(h.core.embed.origins(inst.id)).toHaveLength(EMBED_LIMITS.origins - 1);
  });

  it('goes with the instance', async () => {
    const { inst, p, mi } = await setup();
    await put(mi, [BLOG]);
    h.core.apps.deleteInstance(inst.id, p.id);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });
});

describe('who may choose the websites', () => {
  it('the owner and managers may; contributors, guests and requests without the runtime header may not', async () => {
    const { pi, ci } = await setup();
    expect((await put(pi, [BLOG])).status).toBe(200);
    const contributor = await put(ci, ['https://evil.example']);
    expect(contributor.status).toBe(403);
    expect((await put(undefined, ['https://evil.example'])).status).toBe(403);
    expect((await put(pi, ['https://evil.example'], false)).status).toBe(403);
    expect((await page()).headers['content-security-policy']).toBe(`frame-ancestors 'self' ${BLOG}`);
  });

  it('shows the websites only to the people who manage the instance', async () => {
    const { mi, ci } = await setup();
    await put(mi, [BLOG]);
    const guest = await request(h.app).get('/__lager/embed').set('Host', C);
    expect(guest.status).toBe(200);
    expect(guest.body).toEqual({ origins: [], active: [], limit: EMBED_LIMITS.origins, canManage: false });
    const contributor = await request(h.app).get('/__lager/embed').set('Host', C).set('Cookie', ci);
    expect(contributor.body.origins).toEqual([]);
  });

  it('answers not_found for an app that does not declare embed', async () => {
    const { pi } = await setup({});
    expect((await request(h.app).get('/__lager/embed').set('Host', C).set('Cookie', pi)).status).toBe(404);
    expect((await put(pi, [BLOG])).status).toBe(404);
  });

  it('the session says the capability is there, so the runtime offers the namespace', async () => {
    await setup();
    const s = await request(h.app).get('/__lager/session').set('Host', C);
    expect(s.body.capabilities).toEqual({ embed: {} });
  });
});

describe('instance page: shown on other websites', () => {
  const csrf = (user: User): string => signToken({ uid: user.id, k: 'ui', ep: h.core.users.get(user.id)?.sessionEpoch }, h.core.config.secret, 3600);
  const view = (cookie: string) => request(h.app).get('/instances/comments').set('Host', h.host).set('Cookie', cookie);
  const post = (cookie: string, user: User, path: string, origin: string) =>
    request(h.app).post(`/ui/instances/comments/${path}`).set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), origin });

  it('lists the websites, adds one (a trailing slash is forgiven) and removes it', async () => {
    const { inst, p, pc } = await setup();
    expect((await view(pc)).text).toContain(en('instance.embed.none'));
    const added = await post(pc, p, 'embed', `${BLOG}/`);
    expect(added.status).toBe(302);
    expect(h.core.embed.origins(inst.id)).toEqual([BLOG]);
    const shown = await view(pc);
    expect(shown.text).toContain(en('instance.embed.title'));
    expect(shown.text).toContain(`<span class="mono">${BLOG}</span>`);
    await post(pc, p, 'embed/remove', BLOG);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });

  it('refuses an address of this Lager with a notice, and has no card for an app without embed', async () => {
    const { inst, p, pc } = await setup();
    const refused = await post(pc, p, 'embed', 'http://other.apps.localhost:8080');
    expect(refused.status).toBe(302);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
    expect((await request(h.app).get(refused.headers.location).set('Host', h.host).set('Cookie', pc)).text).toContain(en('notice.originLager'));
    h.core.apps.deploy({ slug: 'comments', html: '<p>2</p>', userId: p.id });
    expect((await view(pc)).text).not.toContain(en('instance.embed.title'));
    expect((await post(pc, p, 'embed', BLOG)).status).toBe(404);
    expect(h.core.embed.origins(inst.id)).toEqual([]);
  });
});
