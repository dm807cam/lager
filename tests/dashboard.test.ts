import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const setup = (): Harness => (h = makeHarness({ extensions: [dashboardExtension] }));
const csrfFor = (hh: Harness): string => signToken({ uid: hh.adminId, k: 'ui' }, hh.core.config.secret, 3600);
const get = (hh: Harness, cookie: string) => request(hh.app).get('/').set('Host', hh.host).set('Cookie', cookie);
const post = (hh: Harness, cookie: string, path: string, body: Record<string, string>) =>
  request(hh.app).post(path).set('Host', hh.host).set('Cookie', cookie).type('form').send(body);

function deploy(hh: Harness, slug: string, html: string, title?: string, note?: string): void {
  hh.core.apps.deploy({ slug, html, title, note, userId: hh.adminId });
}

describe('dashboard', () => {
  it('redirects to /login without session', async () => {
    const h = setup();
    const res = await request(h.app).get('/').set('Host', h.host);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?return=%2F');
  });

  it('POST without a session redirects to /login?return=/ (not the form path)', async () => {
    const h = setup();
    const res = await request(h.app).post('/ui/tokens').set('Host', h.host).type('form').send({ name: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?return=%2F');
  });

  it('the logout form carries a csrf token', async () => {
    const h = setup();
    const res = await get(h, await h.login());
    const m = /action="\/logout"><input type="hidden" name="csrf" value="([^"]+)"/.exec(res.text);
    expect(m).not.toBeNull();
    const out = await request(h.app).post('/logout').set('Host', h.host).set('Cookie', await h.login()).type('form').send({ csrf: m![1] });
    expect(out.status).toBe(302);
  });

  it('shows empty state', async () => {
    const h = setup();
    const res = await get(h, await h.login());
    expect(res.status).toBe(200);
    expect(res.text).toContain('Noch keine Apps');
    expect(res.text).toContain('admin@x.y');
    expect(res.text).toContain('href="/icon.webp"');
  });

  it('lists apps, versions, snapshots and the connector url', async () => {
    const h = setup();
    deploy(h, 'notes', '<p>1</p>', 'Notizen', 'first');
    deploy(h, 'notes', '<p>2</p>', 'Notizen', 'second');
    const inst = h.core.apps.getInstanceBySlug('notes')!;
    h.core.data.set(inst.id, 'notes/n1', { text: 'x' }, h.adminId);
    h.core.data.snapshot(inst.id, 'manual-one');
    const res = await get(h, await h.login());
    expect(res.text).toContain('http://lager.localhost:8080/mcp');
    expect(res.text).toContain('Notizen');
    expect(res.text).toContain('href="http://notes.apps.localhost:8080"');
    expect(res.text).toContain('first');
    expect(res.text).toContain('second');
    expect(res.text).toContain('manual-one');
    expect(res.text).toContain('Wiederherstellen');
    expect(res.text).toContain('Aktivieren');
    expect(res.text).toContain('Alle Angemeldeten');
    expect(res.text).toContain('action="/ui/instances/notes/activate"');
  });

  it('activate via form rolls back', async () => {
    const h = setup();
    deploy(h, 'notes', '<p>1</p>');
    deploy(h, 'notes', '<p>2</p>');
    const inst = h.core.apps.getInstanceBySlug('notes')!;
    expect(inst.activeVersion).toBe(2);
    const res = await post(h, await h.login(), '/ui/instances/notes/activate', { version: '1', csrf: csrfFor(h) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(h.core.apps.getInstanceBySlug('notes')!.activeVersion).toBe(1);
  });

  it('visibility and restore via form', async () => {
    const h = setup();
    deploy(h, 'notes', '<p>1</p>');
    const inst = h.core.apps.getInstanceBySlug('notes')!;
    const cookie = await h.login();
    const vis = await post(h, cookie, '/ui/instances/notes/visibility', { visibility: 'public', csrf: csrfFor(h) });
    expect(vis.status).toBe(302);
    expect(h.core.apps.getInstanceBySlug('notes')!.visibility).toBe('public');
    h.core.data.set(inst.id, 'notes/n1', { text: 'x' }, h.adminId);
    const snap = h.core.data.snapshot(inst.id, 'keep-me')!;
    const res = await post(h, cookie, '/ui/instances/notes/restore', { snapshot: snap.id, csrf: csrfFor(h) });
    expect(res.status).toBe(302);
    expect(h.core.data.listSnapshots(inst.id).some((s) => s.label === 'pre-restore')).toBe(true);
  });

  it('form without csrf → 403', async () => {
    const h = setup();
    deploy(h, 'notes', '<p>1</p>');
    deploy(h, 'notes', '<p>2</p>');
    const cookie = await h.login();
    const none = await post(h, cookie, '/ui/instances/notes/activate', { version: '1' });
    expect(none.status).toBe(403);
    const other = signToken({ uid: 'someone-else', k: 'ui' }, h.core.config.secret, 3600);
    const wrongUser = await post(h, cookie, '/ui/instances/notes/activate', { version: '1', csrf: other });
    expect(wrongUser.status).toBe(403);
    const wrongKind = signToken({ uid: h.adminId }, h.core.config.secret, 3600);
    const kind = await post(h, cookie, '/ui/instances/notes/activate', { version: '1', csrf: wrongKind });
    expect(kind.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('notes')!.activeVersion).toBe(2);
  });

  it('form without session redirects to login', async () => {
    const h = setup();
    const res = await request(h.app).post('/ui/tokens').set('Host', h.host).type('form').send({ name: 'x', csrf: csrfFor(h) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('escapes titles', async () => {
    const h = setup();
    deploy(h, 'xss', '<p>x</p>', '<script>alert(1)</script>', '"><img src=x onerror=alert(2)>');
    const res = await get(h, await h.login());
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<img src=x');
  });

  it('new token is shown once', async () => {
    const h = setup();
    const cookie = await h.login();
    const created = await post(h, cookie, '/ui/tokens', { name: 'laptop', csrf: csrfFor(h) });
    expect(created.status).toBe(200);
    const token = /lgr_[A-Za-z0-9_-]+/.exec(created.text)?.[0];
    expect(token).toBeTruthy();
    expect(h.core.tokens.verify(token!)?.id).toBe(h.adminId);
    const after = await get(h, cookie);
    expect(after.text).toContain('laptop');
    expect(after.text).not.toContain(token!);
    const info = h.core.tokens.list(h.adminId)[0];
    const revoke = await post(h, cookie, `/ui/tokens/${info.id}/revoke`, { csrf: csrfFor(h) });
    expect(revoke.status).toBe(302);
    expect(h.core.tokens.list(h.adminId)).toHaveLength(0);
  });

  it('serves the icon publicly', async () => {
    const h = setup();
    const res = await request(h.app).get('/icon.webp').set('Host', h.host);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('max-age');
  });
});

describe('skill', () => {
  it('skill body equals guide', () => {
    const skill = fs.readFileSync(new URL('../skill/lager/SKILL.md', import.meta.url), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/^name: lager$/m);
    expect(m![1]).toMatch(/^description: .+/m);
    const guide = fs.readFileSync(new URL('../src/guide.md', import.meta.url), 'utf8');
    expect(skill.slice(m![0].length).trim()).toBe(guide.trim());
  });
});
