import { JSDOM } from 'jsdom';
import request from 'supertest';
import { adminExtension } from '../../src/http/admin.js';
import { apiExtension } from '../../src/http/api.js';
import { dashboardExtension } from '../../src/http/dashboard.js';
import { manageExtension } from '../../src/http/manage.js';
import { mcpExtension } from '../../src/mcp/http.js';
import { MemoryMailer } from '../../src/platform/mail.js';
import { makeHarness, type Harness } from './http.js';

/**
 * A platform with something on every page: the administrator owns `notes` (two versions, a snapshot, grants to a user and a
 * group, a custom domain, a collaborator) and a disabled second instance; the publisher Pia owns the self-service app `tasks`
 * whose instance is visible to all users and shared with the administrator; Uwe is a plain user with a share; one open
 * invitation, one API token, one unconfirmed registration.
 */
export interface Showcase {
  h: Harness;
  mailer: MemoryMailer;
  ids: { pia: string; uwe: string; group: string };
  /** The token of the open invitation and the verification token of the unconfirmed registration. */
  invite: string;
  verify: string;
}

export const PASSWORD = 'password-123';

export async function showcase(): Promise<Showcase> {
  const mailer = new MemoryMailer();
  const h = makeHarness({ mailer, publicUrl: 'http://localhost:8080', extensions: [apiExtension, mcpExtension, dashboardExtension, manageExtension, adminExtension] });
  const { core } = h;
  const admin = core.users.get(h.adminId)!;
  const pia = core.users.create({ email: 'pia@x.y', name: 'Pia Publisher', password: PASSWORD, role: 'publisher' });
  const uwe = core.users.create({ email: 'uwe@x.y', name: 'Uwe', password: PASSWORD, role: 'user' });
  core.settings.setRegistration('open');
  core.settings.setCustomDomains('publishers');

  core.apps.deploy({ slug: 'notes', html: '<p>1</p>', title: 'Notes', note: 'first', userId: h.adminId, description: 'Quick notes that sync between your devices.' });
  core.apps.deploy({
    slug: 'notes', html: '<p>2</p>', userId: h.adminId,
    // Two ingest endpoints, so the instance page shows that card. The website that may send is the instance's own custom
    // domain (added below): the pages name it, and the test for addresses of other hosts knows it as this server's.
    capabilities: { ingest: { endpoints: [{ name: 'clips', auth: 'token' }, { name: 'feedback', auth: 'none', origins: ['http://notes.example.com:8080'] }] } },
  });
  const notes = core.apps.getInstanceBySlug('notes')!;
  core.data.snapshot(notes.id, 'before-import');
  core.access.setGrant(notes, 'user', uwe.id, 'view', admin);
  const group = core.groups.create('Team');
  core.groups.addMember(group.id, uwe.id);
  core.access.setGrant(notes, 'group', group.id, 'interact', admin);
  core.domains.add(notes, 'notes.example.com', admin, true);
  core.apps.addCollaborator(core.apps.getApp('notes')!.id, pia.id, h.adminId);
  const old = core.apps.createInstance({ appId: notes.appId, slug: 'old-notes', ownerId: h.adminId });
  core.apps.setInstanceDisabled(old.id, true);

  core.apps.deploy({ slug: 'tasks', html: '<p>t</p>', title: 'Tasks', userId: pia.id });
  const tasks = core.apps.getInstanceBySlug('tasks')!;
  core.apps.setSelfInstances(core.apps.getApp('tasks')!.id, 'users', pia.id);
  core.apps.setVisibility(tasks.id, 'users', pia.id);
  core.access.setGrant(tasks, 'user', h.adminId, 'interact', pia);

  core.tokens.create(h.adminId, 'laptop');
  const { url } = await core.accounts.createInvite({ role: 'user', createdBy: h.adminId, locale: 'en' });
  await core.accounts.register({ name: 'Nova', email: 'nova@x.y', password: PASSWORD, locale: 'en' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const verifyMail = mailer.sent.find((m) => m.to === 'nova@x.y' || m.text.includes('/verify?token='))!;
  const verify = new URL(/https?:\/\/\S+/.exec(verifyMail.text)![0]).searchParams.get('token')!;
  return { h, mailer, ids: { pia: pia.id, uwe: uwe.id, group: group.id }, invite: new URL(url).searchParams.get('invite')!, verify };
}

/** A form as the server sees it: where it posts and which fields it sends. */
export interface FormShape { action: string; method: string; fields: string[] }

/** The forms of a page, sorted, with record ids replaced by stable names so the result does not depend on the run. */
export function formsOf(html: string, names: Map<string, string> = new Map()): FormShape[] {
  const doc = new JSDOM(html).window.document;
  const rename = (s: string): string => [...names].reduce((out, [id, name]) => out.split(id).join(name), s);
  return [...doc.querySelectorAll('form')].map((f) => ({
    action: rename(f.getAttribute('action') ?? ''),
    method: (f.getAttribute('method') ?? 'get').toLowerCase(),
    fields: [...f.querySelectorAll('input[name], select[name], textarea[name], button[name]')].map((el) => el.getAttribute('name')!).sort(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** A field as the server receives it: its name, type and limits, and its value when that value is fixed by the page. */
export interface FieldDetail { name: string; type: string; required: boolean; maxlength: string | null; value?: string }
export interface FormDetail { action: string; method: string; fields: FieldDetail[] }

/** Hidden fields whose values change with every run (tokens, random ids); their values are not recorded. */
const VOLATILE = new Set(['csrf', 'token', 'invite', 'client_id', 'snapshot']);

/** `formsOf` with each field's type, `required`, `maxlength` and, for hidden fields, the value the page fixes. */
export function formDetailsOf(html: string, names: Map<string, string> = new Map()): FormDetail[] {
  const doc = new JSDOM(html).window.document;
  const rename = (s: string): string => [...names].reduce((out, [id, name]) => out.split(id).join(name), s);
  return [...doc.querySelectorAll('form')].map((f) => ({
    action: rename(f.getAttribute('action') ?? ''),
    method: (f.getAttribute('method') ?? 'get').toLowerCase(),
    fields: [...f.querySelectorAll('input[name], select[name], textarea[name], button[name]')].map((el) => {
      const name = el.getAttribute('name')!;
      const type = el.tagName === 'INPUT' ? el.getAttribute('type') ?? 'text' : el.tagName.toLowerCase();
      const fixed = (type === 'hidden' || el.tagName === 'BUTTON') && !VOLATILE.has(name);
      return { name, type, required: el.hasAttribute('required'), maxlength: el.getAttribute('maxlength'), ...(fixed ? { value: rename(el.getAttribute('value') ?? '') } : {}) };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** The home page of a plain user and of a publisher on a platform with nothing on it (no instances, no catalog). */
export async function emptyHomes(): Promise<Array<{ name: string; html: string }>> {
  const h = makeHarness({ publicUrl: 'http://localhost:8080', extensions: [dashboardExtension] });
  try {
    const out: Array<{ name: string; html: string }> = [];
    for (const [name, role] of [['home (empty, user)', 'user'], ['home (empty, publisher)', 'publisher']] as const) {
      const email = `${role}@x.y`;
      h.core.users.create({ email, name: role, password: PASSWORD, role });
      const res = await request(h.app).get('/').set('Host', h.host).set('Cookie', await h.login(email, PASSWORD));
      out.push({ name, html: res.text });
    }
    return out;
  } finally {
    h.core.close();
  }
}

/** Every record id of the showcase that can appear in a form action, mapped to a readable stand-in. */
export function idNames(s: Showcase): Map<string, string> {
  const { core } = s.h;
  const names = new Map<string, string>();
  for (const u of core.users.list()) names.set(u.id, `{user:${u.email}}`);
  for (const g of core.groups.list()) names.set(g.id, `{group:${g.name}}`);
  for (const a of core.apps.listAllApps()) names.set(a.id, `{app:${a.slug}}`);
  for (const i of core.accounts.listInvites()) names.set(i.id, `{invite:${i.role}}`);
  for (const u of core.users.list()) for (const tk of core.tokens.list(u.id)) names.set(tk.id, `{token:${tk.name}}`);
  return names;
}

export interface PageVisit {
  name: string; path: string; as: 'admin' | 'pia' | 'uwe' | null; status?: number; method?: 'get' | 'post'; body?: Record<string, string>;
  /** State the page needs, set up right before the request and undone right after it, so other visits see the showcase as seeded. */
  before?: (s: Showcase) => void; after?: (s: Showcase) => void;
}

/** The pages every form-shape and shell test visits. */
export function pageVisits(s: Showcase): PageVisit[] {
  return [
    { name: 'home (administrator)', path: '/', as: 'admin' },
    { name: 'home (publisher)', path: '/', as: 'pia' },
    { name: 'home (user)', path: '/', as: 'uwe' },
    { name: 'publish (administrator)', path: '/publish', as: 'admin' },
    { name: 'publish (publisher)', path: '/publish', as: 'pia' },
    { name: 'instance', path: '/instances/notes', as: 'admin' },
    { name: 'instance (disabled)', path: '/instances/old-notes', as: 'admin' },
    { name: 'instance (publisher)', path: '/instances/tasks', as: 'pia' },
    { name: 'app (owner)', path: '/apps/notes', as: 'admin' },
    { name: 'app (collaborator)', path: '/apps/notes', as: 'pia' },
    { name: 'admin users', path: '/admin/users', as: 'admin' },
    { name: 'admin user', path: `/admin/users/${s.ids.uwe}`, as: 'admin' },
    { name: 'admin invites', path: '/admin/invites', as: 'admin' },
    { name: 'admin groups', path: '/admin/groups', as: 'admin' },
    { name: 'admin group', path: `/admin/groups/${s.ids.group}`, as: 'admin' },
    { name: 'admin settings', path: '/admin/settings', as: 'admin' },
    { name: 'admin apps', path: '/admin/apps', as: 'admin' },
    { name: 'admin domains', path: '/admin/instances/notes/domains', as: 'admin' },
    { name: 'account', path: '/account', as: 'admin' },
    { name: 'login', path: '/login', as: null },
    { name: 'login (unconfirmed)', path: '/login', as: null, method: 'post', status: 401, body: { email: 'nova@x.y', password: PASSWORD } },
    { name: 'register', path: '/register', as: null },
    { name: 'register (invited)', path: `/register?invite=${s.invite}`, as: null },
    { name: 'forgot', path: '/forgot', as: null },
    { name: 'reset', path: '/reset?token=abc', as: null },
    { name: 'verify', path: `/verify?token=${s.verify}`, as: null },
    { name: 'verify (invalid link)', path: '/verify?token=nope', as: null, status: 400 },
    { name: 'register (closed)', path: '/register', as: null, before: (sc) => sc.h.core.settings.setRegistration('closed'), after: (sc) => sc.h.core.settings.setRegistration('open') },
    { name: 'register (invite only)', path: '/register', as: null, before: (sc) => sc.h.core.settings.setRegistration('invite'), after: (sc) => sc.h.core.settings.setRegistration('open') },
    { name: 'forgot (sent)', path: '/forgot', as: null, method: 'post', body: { email: 'somebody@x.y' } },
    {
      name: 'instance (manager)', path: '/instances/notes', as: 'pia',
      before: (sc) => sc.h.core.access.setGrant(sc.h.core.apps.getInstanceBySlug('notes')!, 'user', sc.ids.pia, 'admin', sc.h.core.users.get(sc.h.adminId)!),
      after: (sc) => sc.h.core.access.removeGrant(sc.h.core.apps.getInstanceBySlug('notes')!, 'user', sc.ids.pia, sc.h.core.users.get(sc.h.adminId)!),
    },
  ];
}

/** Signs in as the given account and returns the cookie, cached per account. */
export function cookies(s: Showcase): (who: PageVisit['as']) => Promise<string> {
  const cache = new Map<string, string>();
  const emails = { admin: 'admin@x.y', pia: 'pia@x.y', uwe: 'uwe@x.y' } as const;
  return async (who) => {
    if (who === null) return '';
    if (!cache.has(who)) cache.set(who, await (who === 'admin' ? s.h.login() : s.h.login(emails[who], PASSWORD)));
    return cache.get(who)!;
  };
}

export async function visit(s: Showcase, v: PageVisit, cookieOf: (who: PageVisit['as']) => Promise<string>, extra: Record<string, string> = {}): Promise<request.Response> {
  const cookie = await cookieOf(v.as);
  v.before?.(s);
  try {
    return await send(s, v, cookie, extra);
  } finally {
    v.after?.(s);
  }
}

function send(s: Showcase, v: PageVisit, cookie: string, extra: Record<string, string>): request.Test {
  const req = v.method === 'post'
    ? request(s.h.app).post(v.path).set('Host', s.h.host).type('form').send(v.body ?? {})
    : request(s.h.app).get(v.path).set('Host', s.h.host);
  if (cookie) req.set('Cookie', cookie);
  for (const [k, val] of Object.entries(extra)) req.set(k, val);
  return req;
}

/** The consent page of a real authorization request by a client named `clientName`. */
export async function consentHtml(s: Showcase, clientName = 'Claude'): Promise<string> {
  const reg = await request(s.h.app).post('/register').set('Host', s.h.host)
    .send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: clientName, token_endpoint_auth_method: 'none' });
  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'st',
  });
  const res = await request(s.h.app).get(`/authorize?${q}`).set('Host', s.h.host).set('Cookie', await s.h.login());
  return res.text;
}
