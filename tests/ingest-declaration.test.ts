import { describe, expect, it } from 'vitest';
import { checkCapabilities } from '../src/mcp/tools.js';
import { checkApp } from '../src/platform/check.js';
import { canRead, type Viewer } from '../src/data/rules.js';
import { effectiveRules, INGEST_LIMITS, ingestEndpoints, parseIngest, parseManagedOrigins } from '../src/platform/ingest.js';

const one = (endpoint: Record<string, unknown>): unknown => ({ endpoints: [endpoint] });
const message = (declaration: unknown): string => {
  try { parseIngest(declaration); } catch (e) { return (e as Error).message; }
  return '';
};

describe('the ingest declaration', () => {
  it('fills in the defaults', () => {
    expect(parseIngest(one({ name: 'hits', auth: 'none', origins: ['https://blog.example.com'] }))).toEqual([{
      name: 'hits', collection: 'hits', auth: 'none', origins: ['https://blog.example.com'], managedOrigins: false, maxBytes: 4096, maxPerDay: 10_000,
      onFull: 'refuse', visitor: false, country: false,
    }]);
    expect(parseIngest(one({
      name: 'weight', collection: 'log/main/weights', auth: 'token', maxBytes: 2048, maxPerDay: 50, onFull: 'rotate', visitor: 'daily', country: true,
    }))).toEqual([{
      name: 'weight', collection: 'log/main/weights', auth: 'token', origins: [], managedOrigins: false, maxBytes: 2048, maxPerDay: 50, onFull: 'rotate', visitor: true, country: true,
    }]);
    expect(parseIngest({})).toEqual([]);
    expect(parseIngest({ endpoints: [] })).toEqual([]);
  });

  it('auth "none" needs listed websites and never takes "*"', () => {
    expect(message(one({ name: 'hits', auth: 'none' }))).toMatch(/needs origins/);
    expect(message(one({ name: 'hits', auth: 'none', origins: [] }))).toMatch(/needs origins/);
    expect(message(one({ name: 'hits', auth: 'none', origins: ['*'] }))).toMatch(/only allowed alone and with auth "token"/);
    expect(message(one({ name: 'hits', auth: 'token', origins: ['*', 'https://a.example'] }))).toMatch(/only allowed alone/);
    expect(parseIngest(one({ name: 'hits', auth: 'token', origins: ['*'] }))[0].origins).toEqual(['*']);
  });

  it('lets the people who manage an instance name the websites when it says managedOrigins', () => {
    expect(parseIngest(one({ name: 'hits', auth: 'none', managedOrigins: true }))[0]).toMatchObject({ origins: [], managedOrigins: true });
    expect(parseIngest(one({ name: 'hits', auth: 'none', origins: ['https://lager.example'], managedOrigins: true }))[0])
      .toMatchObject({ origins: ['https://lager.example'], managedOrigins: true });
    expect(parseIngest(one({ name: 'hits', auth: 'token', managedOrigins: true }))[0].managedOrigins).toBe(true);
    expect(message(one({ name: 'hits', auth: 'none', managedOrigins: false }))).toMatch(/needs origins.*or managedOrigins: true/);
    expect(message(one({ name: 'hits', auth: 'none', managedOrigins: 'yes' }))).toMatch(/managedOrigins must be true or false/);
    expect(message(one({ name: 'hits', auth: 'token', origins: ['*'], managedOrigins: true }))).toMatch(/every website may already send/);
  });

  it('checks the websites an instance adds like declared ones', () => {
    const [managed] = parseIngest(one({ name: 'hits', auth: 'none', origins: ['https://a.example'], managedOrigins: true }));
    // A declared website is kept as entered: it stays open should a later version stop declaring it.
    expect(parseManagedOrigins(managed, [' HTTPS://Blog.Example.com ', 'https://blog.example.com', 'https://a.example', 'http://localhost:4000']))
      .toEqual(['https://blog.example.com', 'https://a.example', 'http://localhost:4000']);
    expect(parseManagedOrigins(managed, [])).toEqual([]);
    const bad = (list: unknown): string => { try { parseManagedOrigins(managed, list); } catch (e) { return (e as Error).message; } return ''; };
    for (const o of ['*', 'blog.example.com', 'https://blog.example.com/', 'https://*.example.com', 'javascript:alert(1)', 5, null]) {
      expect(bad([o]), String(o)).toMatch(/is not a website address/);
    }
    expect(bad('https://blog.example.com')).toMatch(/must be a list/);
    expect(bad(Array.from({ length: INGEST_LIMITS.origins }, (_, i) => `https://s${i}.example`))).toMatch(/at most 19 can be added/);
    expect(parseManagedOrigins(managed, Array.from({ length: INGEST_LIMITS.origins - 1 }, (_, i) => `https://s${i}.example`))).toHaveLength(19);
    // Declared ones do not count twice.
    expect(parseManagedOrigins(managed, ['https://a.example', ...Array.from({ length: 19 }, (_, i) => `https://s${i}.example`)])).toHaveLength(20);
    expect(bad(['x'.repeat(5000)]).length).toBeLessThan(200);
    // Over the limit only through a later declaration: dropping websites is always taken, adding one is not.
    const [crowded] = parseIngest(one({ name: 'hits', auth: 'none', origins: Array.from({ length: 15 }, (_, i) => `https://app${i}.example`), managedOrigins: true }));
    const stored = Array.from({ length: 10 }, (_, i) => `https://mine${i}.example`);
    expect(parseManagedOrigins(crowded, stored.slice(1), stored)).toEqual(stored.slice(1));
    expect(() => parseManagedOrigins(crowded, [...stored.slice(1), 'https://new.example'], stored)).toThrow(/at most 5 can be added/);
    const [fixed] = parseIngest(one({ name: 'hits', auth: 'none', origins: ['https://a.example'] }));
    expect(() => parseManagedOrigins(fixed, ['https://b.example'])).toThrow(/cannot be changed per instance/);
  });

  it('takes an origin only as scheme, host and port', () => {
    for (const bad of ['blog.example.com', 'https://blog.example.com/', 'https://blog.example.com/path', 'ftp://blog.example.com', 'https://user@blog.example.com', 'null', '', 5, 'https://blog.example.com:443', 'https://*.example.com', 'https://blog_example.com']) {
      expect(message(one({ name: 'hits', auth: 'none', origins: [bad] })), String(bad)).toMatch(/is not an origin/);
    }
    expect(parseIngest(one({ name: 'hits', auth: 'none', origins: ['HTTPS://Blog.Example.com', 'https://blog.example.com', 'http://localhost:4000'] }))[0].origins)
      .toEqual(['https://blog.example.com', 'http://localhost:4000']);
    expect(message(one({ name: 'hits', auth: 'none', origins: Array.from({ length: INGEST_LIMITS.origins + 1 }, (_, i) => `https://s${i}.example`) }))).toMatch(/at most 20 origins/);
  });

  it('refuses what it does not understand', () => {
    expect(message([])).toMatch(/ingest must be an object/);
    expect(message({ endpoints: {} })).toMatch(/must be an array/);
    expect(message({ endpoints: ['hits'] })).toMatch(/must be an object/);
    expect(message(one({ auth: 'token' }))).toMatch(/needs a name/);
    for (const name of ['Hits', '1hits', 'hits/2', 'a'.repeat(49), '', '../x']) expect(message(one({ name, auth: 'token' })), name).toMatch(/needs a name/);
    expect(message(one({ name: 'hits' }))).toMatch(/auth must be/);
    expect(message(one({ name: 'hits', auth: 'cookie' }))).toMatch(/auth must be/);
    // A misspelt field must not silently mean "no restriction".
    expect(message(one({ name: 'hits', auth: 'token', origin: ['https://a.example'] }))).toMatch(/unknown field "origin"/);
    expect(message(one({ name: 'hits', auth: 'token', onFull: 'drop' }))).toMatch(/onFull must be/);
    expect(message(one({ name: 'hits', auth: 'token', visitor: true }))).toMatch(/visitor must be "daily"/);
    expect(message(one({ name: 'hits', auth: 'token', country: 'yes' }))).toMatch(/country must be/);
    expect(message({ endpoints: [{ name: 'a', auth: 'token' }, { name: 'a', auth: 'token' }] })).toMatch(/declared twice/);
    expect(message({ endpoints: Array.from({ length: INGEST_LIMITS.endpoints + 1 }, (_, i) => ({ name: `e${i}`, auth: 'token' })) })).toMatch(/at most 8 endpoints/);
  });

  it('holds sizes and daily numbers to the server\'s maximum', () => {
    for (const maxBytes of [0, -1, 1.5, '4096', INGEST_LIMITS.maxBytes + 1]) expect(message(one({ name: 'hits', auth: 'token', maxBytes })), String(maxBytes)).toMatch(/maxBytes must be a whole number from 1 to 65536/);
    for (const maxPerDay of [0, INGEST_LIMITS.maxPerDay + 1, null]) expect(message(one({ name: 'hits', auth: 'token', maxPerDay })), String(maxPerDay)).toMatch(/maxPerDay must be a whole number from 1 to 100000/);
    expect(parseIngest(one({ name: 'hits', auth: 'token', maxBytes: INGEST_LIMITS.maxBytes, maxPerDay: INGEST_LIMITS.maxPerDay }))[0]).toMatchObject({ maxBytes: 65536, maxPerDay: 100000 });
  });

  it('writes into a collection, never into a document path or a private area', () => {
    expect(message(one({ name: 'hits', auth: 'token', collection: 'inbox/hits' }))).toMatch(/collection path is required/);
    expect(message(one({ name: 'hits', auth: 'token', collection: 'a b' }))).toMatch(/characters other than/);
    expect(message(one({ name: 'hits', auth: 'token', collection: 7 }))).toMatch(/collection must be/);
    for (const collection of ['data/users/u1', 'Data/Users/u1', 'data/users/u1/inbox/main/x/files']) {
      expect(message(one({ name: 'hits', auth: 'token', collection })), collection).toMatch(/private area/);
    }
    expect(parseIngest(one({ name: 'hits', auth: 'token', collection: 'data' }))[0].collection).toBe('data');
  });

  it('a stored declaration that does not parse declares no endpoint at all', () => {
    expect(ingestEndpoints({ ingest: { endpoints: [{ name: 'ok', auth: 'token' }, { name: 'open', auth: 'none', origins: ['*'] }] } })).toEqual([]);
    expect(ingestEndpoints({ ingest: true } as never)).toEqual([]);
    expect(ingestEndpoints({})).toEqual([]);
    expect(ingestEndpoints(undefined)).toEqual([]);
  });

  it('a deploy and check_app refuse a bad declaration with its reason', () => {
    expect(() => checkCapabilities({ ingest: one({ name: 'hits', auth: 'none', origins: ['*'] }) })).toThrow(/Invalid capabilities: ingest endpoint "hits": origins \["\*"\]/);
    expect(() => checkCapabilities({ ingest: true })).toThrow(/ingest must be an object/);
    expect(checkCapabilities({ ingest: one({ name: 'hits', auth: 'token' }) })).toEqual({ ingest: one({ name: 'hits', auth: 'token' }) });
  });

  it('"anyone" is a level for writing only', () => {
    expect(checkCapabilities({ db: { rules: [{ path: 'rsvps', read: 'admin', write: 'anyone' }] } })).toBeDefined();
    expect(() => checkCapabilities({ db: { rules: [{ path: 'rsvps', read: 'anyone' }] } })).toThrow(/read must be one of view, interact, admin, owner, self, none\./);
    expect(() => checkCapabilities({ db: { rules: [{ path: 'rsvps', write: 'everyone' }] } })).toThrow(/write must be one of view, interact, admin, owner, self, none, anyone\./);
  });
});

describe('the rules the server applies', () => {
  const endpoints = [{ name: 'hits', auth: 'token' }, { name: 'more', collection: 'hits', auth: 'token' }, { name: 'mail', collection: 'inbox/main/mail', auth: 'token' }];

  it('keep what an endpoint receives to managers where the app says nothing about reading it', () => {
    expect(effectiveRules({ ingest: { endpoints } })).toEqual([{ path: 'hits', read: 'admin' }, { path: 'inbox/main/mail', read: 'admin' }]);
    // A rule that only speaks of writing, or of another path, says nothing about reading the collection.
    const rules = [{ path: 'hits', write: 'owner' as const }, { path: 'inbox/other', read: 'view' as const }, { path: 'hits/h1/notes', read: 'view' as const }];
    expect(effectiveRules({ db: { rules }, ingest: { endpoints } })).toEqual([...rules, { path: 'hits', read: 'admin' }, { path: 'inbox/main/mail', read: 'admin' }]);
  });

  it('leave a collection to the app\'s own rule, whether that rule is for it or for a path above it', () => {
    // Opened on purpose…
    const open = [{ path: 'hits', read: 'view' as const }];
    expect(effectiveRules({ db: { rules: open }, ingest: { endpoints } })).toEqual([...open, { path: 'inbox/main/mail', read: 'admin' }]);
    // …or closed further than the default would: the default must never open what the app closed.
    const closed = [{ path: 'inbox', read: 'owner' as const }, { path: 'hits', read: 'self' as const }];
    expect(effectiveRules({ db: { rules: closed }, ingest: { endpoints } })).toBe(closed);
    const manager: Viewer = { userId: 'm', level: 'admin' };
    const rules = effectiveRules({ db: { rules: closed }, ingest: { endpoints } });
    expect(canRead(rules, manager, 'inbox/main/mail/d1')).toBe(false);
    expect(canRead(rules, manager, 'inbox/main/mail/d1/notes/n1')).toBe(false);
    expect(canRead(rules, { userId: 'o', level: 'owner' }, 'inbox/main/mail/d1')).toBe(true);
    // A rule with {self} above the collection counts as the app having spoken.
    const personal = [{ path: 'inbox/{self}', read: 'interact' as const }];
    expect(effectiveRules({ db: { rules: personal }, ingest: { endpoints: [endpoints[2]] } })).toBe(personal);
  });

  it('never read more openly with the default than without it', () => {
    const viewers: Viewer[] = [{ userId: null, level: 'view' }, { userId: 'v', level: 'view' }, { userId: 'e', level: 'interact' }, { userId: 'm', level: 'admin' }, { userId: 'o', level: 'owner' }];
    const sets = [undefined, [], [{ path: 'hits', write: 'admin' as const }], [{ path: 'inbox', read: 'owner' as const }], [{ path: 'inbox/main', read: 'none' as never }],
      [{ path: 'inbox/main/mail/d1', read: 'view' as const }], [{ path: 'hits', read: 'view' as const }, { path: 'inbox/main/mail', read: 'self' as const }]];
    for (const rules of sets) {
      const caps = { ...(rules ? { db: { rules } } : {}), ingest: { endpoints } };
      for (const v of viewers) {
        for (const p of ['hits/h1', 'hits/h1/notes/n1', 'inbox/main/mail/d1', 'inbox/main/mail/d1/notes/n1', 'inbox/other/x', 'tasks/t1']) {
          const withDefault = canRead(effectiveRules(caps), v, p);
          if (withDefault) expect(canRead(rules, v, p), `${JSON.stringify(rules)} ${v.level} ${p}`).toBe(true);
        }
      }
    }
  });

  it('are the declared ones for an app without endpoints', () => {
    const rules = [{ path: 'votes', write: 'owner' as const }];
    expect(effectiveRules({ db: { rules } })).toBe(rules);
    expect(effectiveRules({ db: {} })).toBeUndefined();
    expect(effectiveRules({})).toBeUndefined();
    expect(effectiveRules({ db: { rules: 'all' } } as never)).toBeUndefined();
  });
});

describe('check_app and ingest', () => {
  it('knows the namespace and asks for its declaration', () => {
    const html = '<script>const ingest = await lager.use("ingest");</script>';
    expect(checkApp(html, {})).toMatchObject({ used: ['ingest'], unsupported: [], undeclared: ['ingest'] });
    expect(checkApp(html, { ingest: { endpoints: [{ name: 'w', auth: 'token' }] } })).toMatchObject({ undeclared: [], warnings: [] });
  });

  it('warns once when anyone can add data without an account', () => {
    const caps = {
      db: { rules: [{ path: 'rsvps', write: 'anyone' as const }] },
      ingest: { endpoints: [{ name: 'hits', auth: 'none', origins: ['https://blog.example.com'] }, { name: 'w', auth: 'token' }] },
    };
    expect(checkApp('<p>x</p>', caps).warnings).toEqual([
      'Anyone can add data through the endpoint "hits" and the rule on "rsvps", without an account. Treat what arrives as untrusted: show it with textContent, never as HTML, and never put a secret into the page that sends it.',
    ]);
  });
});
