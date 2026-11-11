import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { hostUrl, instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { assertDocData, parseDocPath } from '../data/paths.js';
import type { QuerySpec } from '../data/query.js';
import { canRead, canWrite, type Viewer } from '../data/rules.js';
import { LagerError } from '../errors.js';
import type { GrantLevel } from '../platform/access.js';
import type { App, Capabilities, DbRule, DeployResult, Instance, Visibility } from '../platform/apps.js';
import type { User } from '../platform/users.js';

const GUIDE = fs.readFileSync(new URL('../guide.md', import.meta.url), 'utf8');
/** First section of the guide (everything before the first line that is exactly `---`). */
const INSTRUCTIONS = (() => {
  const lines = GUIDE.split(/\r?\n/);
  const i = lines.findIndex((l) => l === '---');
  return (i < 0 ? lines : lines.slice(0, i)).join('\n').trim();
})();

export const MAX_DB_OPS = 100;
const GRANT_LEVELS = ['view', 'interact', 'admin'] as const satisfies readonly GrantLevel[];
const RULE_LEVELS = ['view', 'interact', 'admin', 'owner', 'self', 'none'];

// ---- shared shapes (REST and MCP) -----------------------------------------

export interface DomainJson { host: string; url: string }

export function domainsJson(core: Core, i: Instance): DomainJson[] {
  return core.domains.list(i.id).map((host) => ({ host, url: hostUrl(core.config, host) }));
}

/** `url` is the primary address `<slug>.<apps domain>`; custom domains are listed separately. */
export function instanceJson(core: Core, i: Instance): { slug: string; url: string; activeVersion: number; visibility: string; domains: DomainJson[] } {
  return { slug: i.slug, url: instanceUrl(core.config, i.slug), activeVersion: i.activeVersion, visibility: i.visibility, domains: domainsJson(core, i) };
}

/** Instances of the app that `user` may see: their own and those shared with them (never other users' private ones). */
function visibleInstances(core: Core, user: User, appId: string): Instance[] {
  return core.apps.listInstances(appId).filter((i) => core.access.canSeeInstance(i, user));
}

export function appSummary(core: Core, user: User, app: App): object {
  return {
    slug: app.slug, title: app.title, latestVersion: core.apps.latestDeployedVersion(app.id)?.number ?? null,
    instances: visibleInstances(core, user, app.id).map((i) => instanceJson(core, i)),
  };
}

export function appDetail(core: Core, user: User, app: App): object {
  return {
    ...appSummary(core, user, app),
    // Self-published versions hold one instance's state and are not part of the app.
    versions: core.apps.listVersions(app.id).filter((v) => v.instanceId === null).map((v) => ({ number: v.number, createdAt: v.createdAt, note: v.note, sizeBytes: v.sizeBytes })),
  };
}

export function describeDeploy(core: Core, user: User, r: DeployResult): object {
  const pinned = r.pinned.filter((i) => core.access.canSeeInstance(i, user)).map((i) => i.slug);
  const warnings = pinned.length > 0
    ? [...r.warnings, `Diese Instanzen wurden nicht aktualisiert, weil ihre automatische Aktualisierung ausgeschaltet ist: ${pinned.join(', ')}`]
    : r.warnings;
  return {
    app: r.app.slug, version: r.version.number, createdVersion: r.createdVersion,
    // Per instance the primary URL comes first, then its custom domains.
    urls: r.instances.filter((i) => core.access.canSeeInstance(i, user))
      .flatMap((i) => [instanceUrl(core.config, i.slug), ...domainsJson(core, i).map((d) => d.url)]), warnings, pinned,
  };
}

function appBySlug(core: Core, slug: string): App {
  const app = core.apps.getApp(slug);
  if (!app || app.slug !== slug) throw new LagerError('not_found', `App "${slug}" not found.`);
  return app;
}

/** The app with this slug, if `user` owns it or collaborates on it; otherwise not_found / forbidden. */
export function readableApp(core: Core, user: User, slug: string): App {
  const app = appBySlug(core, slug);
  if (!core.access.canReadApp(app, user)) throw new LagerError('forbidden', `You have no access to app "${slug}".`);
  return app;
}

/** The app with this slug, if `user` may create an instance of it (deployers, or anyone for self-service apps). */
export function instantiableApp(core: Core, user: User, slug: string): App {
  const app = appBySlug(core, slug);
  if (!core.access.canCreateInstance(app, user)) throw new LagerError('forbidden', `You may not create instances of app "${slug}".`);
  return app;
}

/** The instance with this slug, if `user` may manage it (owner or instance admin); otherwise not_found / forbidden. */
export function managedInstance(core: Core, user: User, slug: string): Instance {
  const inst = core.apps.getInstanceBySlug(slug);
  if (!inst) throw new LagerError('not_found', `Instance "${slug}" not found.`);
  if (!core.access.canManageInstance(inst, user)) throw new LagerError('forbidden', `You may not manage instance "${slug}".`);
  return inst;
}

// ---- sharing (REST and MCP) -------------------------------------------------

/** Exactly one of `email` / `group` names who a grant is about; groups are addressed by name. */
export function grantPrincipal(core: Core, input: { email?: string; group?: string }): { type: 'user' | 'group'; id: string } {
  const email = input.email?.trim() || undefined;
  const group = input.group?.trim() || undefined;
  if ((email === undefined) === (group === undefined)) throw new LagerError('invalid_argument', 'Give exactly one of email or group.');
  if (email !== undefined) {
    const user = core.users.getByEmail(email);
    if (!user || user.disabled) throw new LagerError('not_found', `No account with the address "${email}".`);
    return { type: 'user', id: user.id };
  }
  const found = core.groups.getByName(group!);
  if (!found) throw new LagerError('not_found', `Group "${group}" not found.`);
  return { type: 'group', id: found.id };
}

export function grantsJson(core: Core, inst: Instance): { grants: Array<{ type: string; label: string; level: string }> } {
  return { grants: core.access.listGrants(inst.id).map((g) => ({ type: g.principalType, label: g.principalLabel, level: g.level })) };
}

export function sharesJson(core: Core, inst: Instance): object {
  return { ...grantsJson(core, inst), visibility: inst.visibility, usersLevel: inst.usersLevel };
}

/**
 * Creates an instance for `user`, or for the account `ownerEmail` if given. Handing an instance to someone
 * else is reserved to those who deploy the app (as on the app page).
 */
export function createInstanceFor(core: Core, user: User, input: { app: string; slug: string; ownerEmail?: string; visibility?: Visibility }): Instance {
  const app = instantiableApp(core, user, input.app);
  const email = input.ownerEmail?.trim();
  let owner = user;
  if (email) {
    if (!core.access.canDeploy(app, user)) throw new LagerError('forbidden', 'Only people who deploy this app may create instances for others.');
    const found = core.users.getByEmail(email);
    if (!found || found.disabled) throw new LagerError('not_found', `No account with the address "${email}".`);
    owner = found;
  }
  return core.apps.createInstance({ appId: app.id, slug: input.slug, ownerId: owner.id, visibility: input.visibility });
}

// ---- custom domains (REST and MCP) -------------------------------------------

/** Attaches `host` to the instance if `user` manages it and may set domains; returns the instance. */
export function addDomainTo(core: Core, user: User, slug: string, host: string): Instance {
  const inst = managedInstance(core, user, slug);
  core.domains.add(inst, host, user, true);
  return inst;
}

export function removeDomainFrom(core: Core, user: User, slug: string, host: string): Instance {
  const inst = managedInstance(core, user, slug);
  core.domains.remove(inst, host, user, true);
  return inst;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validates the parts of a capabilities declaration the platform interprets. */
export function checkCapabilities(value: unknown): Capabilities | undefined {
  if (value === undefined) return undefined;
  const bad = (msg: string): never => { throw new LagerError('invalid_argument', `Invalid capabilities: ${msg}`); };
  if (!isObject(value)) bad('must be an object.');
  const caps = value as Record<string, unknown>;
  if (caps.db !== undefined) {
    if (!isObject(caps.db)) bad('db must be an object.');
    const rules = (caps.db as Record<string, unknown>).rules;
    if (rules !== undefined) {
      if (!Array.isArray(rules)) bad('db.rules must be an array.');
      for (const r of rules as unknown[]) {
        if (!isObject(r) || typeof r.path !== 'string' || r.path === '') bad('every rule needs a path.');
        const rule = r as Record<string, unknown>;
        for (const k of ['read', 'write']) {
          if (rule[k] !== undefined && !RULE_LEVELS.includes(rule[k] as string)) bad(`${k} must be one of ${RULE_LEVELS.join(', ')}.`);
        }
      }
    }
  }
  if (caps.user !== undefined) {
    if (!isObject(caps.user)) bad('user must be an object.');
    const scopes = (caps.user as Record<string, unknown>).scopes;
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string'))) bad('user.scopes must be an array of strings.');
  }
  return caps as Capabilities;
}

// ---- tools -----------------------------------------------------------------

function result(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function run(fn: () => unknown): CallToolResult {
  try {
    return result(fn());
  } catch (e) {
    if (e instanceof LagerError) return result({ error: { code: e.code, message: e.message } }, true);
    console.error(e);
    return result({ error: { code: 'internal', message: 'Internal server error.' } }, true);
  }
}

/**
 * db_read/db_write act with the caller's own level on the instance. The owner ignores the app's rules (to seed data); an instance
 * administrator ("Verwalter") is held to them like at runtime, so rules that require `owner` stay closed. `data/users/<other>/…` is closed for everyone.
 */
function dbAccess(core: Core, user: User, inst: Instance): { viewer: Viewer; rules: DbRule[] | undefined } {
  const level = core.access.levelFor(inst, user);
  const viewer: Viewer = { userId: user.id, level };
  if (level === 'owner') return { viewer, rules: [] };
  const caps = core.apps.listVersions(inst.appId).find((v) => v.number === inst.activeVersion)?.capabilities;
  return { viewer, rules: caps?.db?.rules };
}

const slugArg = z.string().describe('Slug (lowercase letters, digits, hyphens)');
const visibilityArg = z.enum(['private', 'users', 'public']);
const capabilitiesArg = z.record(z.string(), z.unknown())
  .describe('Capabilities of this version, e.g. {"db":{},"user":{}}; db.rules: [{path, read?, write?}]');

export function buildMcpServer(core: Core, user: User): McpServer {
  const server = new McpServer({ name: 'lager', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('deploy_app', {
    description: 'Deploy an artifact (one HTML file) as a new version of the app. Creates the app and its default instance on first deploy. Returns the instance URLs and lint warnings.',
    inputSchema: {
      slug: slugArg, html: z.string().describe('Complete HTML of the artifact'), title: z.string().optional(),
      capabilities: capabilitiesArg.optional(), note: z.string().optional().describe('Short version note'),
    },
  }, ({ slug, html, title, capabilities, note }) => run(() => describeDeploy(core, user, core.apps.deploy({
    slug, html, title, note, capabilities: checkCapabilities(capabilities), userId: user.id,
  }))));

  server.registerTool('list_apps', {
    description: 'List your apps (owned or collaborating) with their instances.',
    inputSchema: {},
  }, () => run(() => ({ apps: core.access.appsOf(user).map((a) => appSummary(core, user, a)) })));

  server.registerTool('get_app', {
    description: 'Show one of your apps (owned or collaborating) with instances and all versions.',
    inputSchema: { slug: slugArg },
  }, ({ slug }) => run(() => appDetail(core, user, readableApp(core, user, slug))));

  server.registerTool('activate_version', {
    description: 'Activate any existing version on an instance (roll back or forward). A snapshot of the instance data is taken first.',
    inputSchema: { instance: slugArg, version: z.number().int().positive() },
  }, ({ instance, version }) => run(() => instanceJson(core, core.apps.activate(managedInstance(core, user, instance).id, version, user.id))));

  server.registerTool('create_instance', {
    description: 'Create another instance of an app with its own subdomain and its own data.',
    inputSchema: {
      app: slugArg, slug: slugArg.describe('Slug of the new instance (globally unique)'), visibility: visibilityArg.optional(),
      owner_email: z.string().optional().describe('E-mail of the account that should own the instance (only for those who deploy the app); default: you'),
    },
  }, ({ app, slug, visibility, owner_email }) => run(() => instanceJson(core, createInstanceFor(core, user, { app, slug, ownerEmail: owner_email, visibility }))));

  server.registerTool('set_visibility', {
    description: 'Set who can open an instance: private (the owner and those it is shared with), users (all signed-in users), public (anyone).',
    inputSchema: { instance: slugArg, visibility: visibilityArg },
  }, ({ instance, visibility }) => run(() => instanceJson(core, core.apps.setVisibility(managedInstance(core, user, instance).id, visibility, user.id))));

  server.registerTool('share_instance', {
    description: 'Give an account (email) or a group (name) access to an instance, or change their level: view (look), interact (also write data per the app\'s rules) or admin (also manage sharing, versions and data). Exactly one of email or group is required. Returns the shares.',
    inputSchema: { instance: slugArg, email: z.string().optional(), group: z.string().optional(), level: z.enum(GRANT_LEVELS) },
  }, ({ instance, email, group, level }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const who = grantPrincipal(core, { email, group });
    core.access.setGrant(inst, who.type, who.id, level, user);
    return sharesJson(core, inst);
  }));

  server.registerTool('unshare_instance', {
    description: 'Withdraw the access of an account (email) or a group (name) from an instance. Exactly one of email or group is required. Returns the remaining shares.',
    inputSchema: { instance: slugArg, email: z.string().optional(), group: z.string().optional() },
  }, ({ instance, email, group }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const who = grantPrincipal(core, { email, group });
    core.access.removeGrant(inst, who.type, who.id, user);
    return sharesJson(core, inst);
  }));

  server.registerTool('list_shares', {
    description: 'Who has access to an instance: the grants (accounts and groups with their level), the visibility and the level given to all signed-in users.',
    inputSchema: { instance: slugArg },
  }, ({ instance }) => run(() => sharesJson(core, managedInstance(core, user, instance))));

  server.registerTool('add_domain', {
    description: 'Let an instance also answer on your own domain (a hostname such as notes.example.com). Allowed for administrators, and for publishers who manage the instance when the administrator enabled it. DNS, proxy entry and certificate for the domain are set up outside Lager; Lager does not check who owns the domain. Returns the instance with its domains.',
    inputSchema: { instance: slugArg, host: z.string().describe('Hostname without scheme, port or path') },
  }, ({ instance, host }) => run(() => instanceJson(core, addDomainTo(core, user, instance, host))));

  server.registerTool('remove_domain', {
    description: 'Detach a custom domain from an instance. Returns the instance with its remaining domains.',
    inputSchema: { instance: slugArg, host: z.string() },
  }, ({ instance, host }) => run(() => instanceJson(core, removeDomainFrom(core, user, instance, host))));

  server.registerTool('db_read', {
    description: 'Read instance data. A document path (even number of segments, e.g. tasks/t1) returns {doc}; a collection path (odd, e.g. tasks) returns {docs}.',
    inputSchema: {
      instance: slugArg, path: z.string(),
      where: z.array(z.tuple([z.string(), z.enum(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any']), z.unknown()]))
        .optional().describe('Filters [field, op, value]'),
      orderBy: z.array(z.tuple([z.string(), z.enum(['asc', 'desc'])])).optional(),
      limit: z.number().int().positive().optional(),
    },
  }, ({ instance, path, where, orderBy, limit }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const { viewer, rules } = dbAccess(core, user, inst);
    if (!canRead(rules, viewer, path)) throw new LagerError('forbidden', 'You may not read this path (another user\'s private area or a rule of the app).');
    if (path.split('/').length % 2 === 0) return { doc: core.data.get(inst.id, path) };
    const spec: QuerySpec = { where: where as QuerySpec['where'], orderBy, limit };
    return { docs: core.data.query(inst.id, path, spec).filter((d) => canRead(rules, viewer, d.path)) };
  }));

  server.registerTool('db_write', {
    description: `Write instance data, e.g. to seed it after a deploy. Up to ${MAX_DB_OPS} operations, applied in order: set (replace), update (deep merge), delete.`,
    inputSchema: {
      instance: slugArg,
      ops: z.array(z.object({
        op: z.enum(['set', 'update', 'delete']), path: z.string().describe('Document path, e.g. tasks/t1'),
        data: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(MAX_DB_OPS),
    },
  }, ({ instance, ops }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const { viewer, rules } = dbAccess(core, user, inst);
    // Validate every operation before applying any of them.
    for (const o of ops) {
      parseDocPath(o.path);
      if (!canWrite(rules, viewer, o.path)) throw new LagerError('forbidden', `You may not write "${o.path}" (another user's private area or a rule of the app).`);
      if (o.op !== 'delete') {
        if (o.data === undefined) throw new LagerError('invalid_argument', `${o.op} on "${o.path}" needs data.`);
        assertDocData(o.data);
      }
    }
    let applied = 0;
    try {
      for (const o of ops) {
        if (o.op === 'delete') core.data.delete(inst.id, o.path);
        else core.data[o.op](inst.id, o.path, o.data!, user.id);
        applied++;
      }
    } catch (e) {
      // The loop is not atomic: tell the caller how far it got.
      if (e instanceof LagerError) throw new LagerError(e.code, `${e.message} ${applied} of ${ops.length} operations were applied before the error.`);
      throw e;
    }
    return { applied };
  }));

  server.registerTool('list_snapshots', {
    description: 'List the data snapshots of an instance, newest first.',
    inputSchema: { instance: slugArg },
  }, ({ instance }) => run(() => ({ snapshots: core.data.listSnapshots(managedInstance(core, user, instance).id) })));

  server.registerTool('restore_snapshot', {
    description: 'Restore instance data from a snapshot. The current data is saved as a snapshot first.',
    inputSchema: { instance: slugArg, snapshot: z.string().describe('Snapshot id from list_snapshots') },
  }, ({ instance, snapshot }) => run(() => {
    core.data.restore(managedInstance(core, user, instance).id, snapshot);
    return { restored: snapshot };
  }));

  server.registerTool('get_guide', {
    description: 'The full guide for building and deploying artifacts on Lager.',
    inputSchema: {},
  }, () => result({ guide: GUIDE }));

  return server;
}
