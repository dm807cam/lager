import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { hostUrl, instanceUrl } from '../config.js';
import type { Core } from '../core.js';
import { assertDocData, parseDocPath } from '../data/paths.js';
import type { QuerySpec } from '../data/query.js';
import { canRead, canWrite, type Viewer } from '../data/rules.js';
import { LagerError } from '../errors.js';
import { SNAPSHOT_ACTIONS_PER_HOUR, withSnapshotBudget } from '../http/snapshot-limit.js';
import type { GrantLevel } from '../platform/access.js';
import { normalizeDescription, normalizeThemeColor, type App, type Capabilities, type DbRule, type DeployResult, type Instance, type Version, type Visibility } from '../platform/apps.js';
import { MODEL_ID_RE } from '../platform/ai.js';
import { checkApp, type AppCheck } from '../platform/check.js';
import { effectiveRules, parseIngest } from '../platform/ingest.js';
import { parseEmbed } from '../platform/embed.js';
import type { User } from '../platform/users.js';

const GUIDE = fs.readFileSync(new URL('../guide.md', import.meta.url), 'utf8');
/** First section of the guide (everything before the first line that is exactly `---`). */
const INSTRUCTIONS = (() => {
  const lines = GUIDE.split(/\r?\n/);
  const i = lines.findIndex((l) => l === '---');
  return (i < 0 ? lines : lines.slice(0, i)).join('\n').trim();
})();

export const MAX_DB_OPS = 100;
export const MAX_IMPORT_DOCS_MCP = 1000;
const EXPORT_DEFAULT_LIMIT = 200;
/** An export call stops after this many bytes of document JSON (and says `truncated`), so one answer stays a sensible size. */
const EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const GRANT_LEVELS = ['view', 'interact', 'admin'] as const satisfies readonly GrantLevel[];
const RULE_LEVELS = ['view', 'interact', 'admin', 'owner', 'self', 'none'];

// ---- shared shapes (REST and MCP) -----------------------------------------

export interface DomainJson { host: string; url: string }

export function domainsJson(core: Core, i: Instance): DomainJson[] {
  return core.domains.list(i.id).map((host) => ({ host, url: hostUrl(core.config, host) }));
}

/** `url` is the primary address `<slug>.<apps domain>`; custom domains are listed separately. */
export function instanceJson(core: Core, i: Instance): { slug: string; url: string; activeVersion: number; visibility: string; domains: DomainJson[]; showBadge: boolean } {
  return { slug: i.slug, url: instanceUrl(core.config, i.slug), activeVersion: i.activeVersion, visibility: i.visibility, domains: domainsJson(core, i), showBadge: i.showBadge };
}

/** Instances of the app that `user` may see: their own and those shared with them (never other users' private ones). */
function visibleInstances(core: Core, user: User, appId: string): Instance[] {
  return core.apps.listInstances(appId).filter((i) => core.access.canSeeInstance(i, user));
}

export const NO_ICON_WARNING = 'No icon supplied; a generated one is used. Pass icon_svg to set your own.';

/** The public 192 px PNG of the app's icon on the platform host; the version in the URL busts caches. */
export function iconUrl(core: Core, app: App): string {
  return `${core.config.publicUrl.origin}/app-icons/${app.id}/${app.iconVersion}/192.png`;
}

/** What every app result says about how the app looks. */
function appLook(core: Core, app: App): { description: string; themeColor: string; iconUrl: string } {
  return { description: app.description, themeColor: app.themeColor, iconUrl: iconUrl(core, app) };
}

export function appSummary(core: Core, user: User, app: App): object {
  return {
    slug: app.slug, title: app.title, ...appLook(core, app), latestVersion: core.apps.latestDeployedVersion(app.id)?.number ?? null,
    instances: visibleInstances(core, user, app.id).map((i) => instanceJson(core, i)),
  };
}

/**
 * The catalog model the latest deployed version asks for in `complete.model`, if any. An instance that runs an older
 * version (pinned, rolled back or saved by the page) follows the declaration of that version instead.
 */
export function declaredModel(core: Core, app: App): string | null {
  const model = core.apps.latestDeployedVersion(app.id)?.capabilities.complete?.model;
  return typeof model === 'string' && model ? model : null;
}

/** The language model part of an app: what its owner chose, what its latest version declares, and which applies. */
function modelJson(core: Core, app: App): object {
  const declared = declaredModel(core, app);
  return { chosen: app.aiModelId, declared, applies: app.aiModelId ?? declared };
}

export function appDetail(core: Core, user: User, app: App): object {
  return {
    ...appSummary(core, user, app),
    model: modelJson(core, app),
    // Self-published versions hold one instance's state and are not part of the app.
    versions: core.apps.listVersions(app.id).filter((v) => v.instanceId === null).map((v) => ({ number: v.number, createdAt: v.createdAt, note: v.note, sizeBytes: v.sizeBytes })),
  };
}

export function describeDeploy(core: Core, user: User, r: DeployResult): object {
  const pinned = r.pinned.filter((i) => core.access.canSeeInstance(i, user)).map((i) => i.slug);
  const warnings = pinned.length > 0
    ? [...r.warnings, `These instances were not updated because their automatic updates are switched off: ${pinned.join(', ')}`]
    : r.warnings;
  return {
    app: r.app.slug, version: r.version.number, createdVersion: r.createdVersion, ...appLook(core, r.app),
    // Per instance the primary URL comes first, then its custom domains.
    urls: r.instances.filter((i) => core.access.canSeeInstance(i, user))
      .flatMap((i) => [instanceUrl(core.config, i.slug), ...domainsJson(core, i).map((d) => d.url)]), warnings, pinned,
  };
}

/** The app's generated icon, written when it has none yet (apps from before icons existed, or a first deploy). Returns the current row. */
export async function ensureDefaultIcon(core: Core, app: App, owner?: string): Promise<App> {
  if (core.icons.has(app.id)) return app;
  await core.icons.ready();
  await core.icons.setDefault(app.id, app.slug, app.themeColor, owner);
  return core.apps.bumpIconVersion(app.id);
}

/** Draws the stored icon again, e.g. because the theme colour behind the maskable variant changed. */
async function redrawIcon(core: Core, app: App, owner?: string): Promise<App> {
  const source = core.icons.source(app.id);
  if (source === null) return app;
  await core.icons.set(app.id, source, app.themeColor, owner);
  return core.apps.bumpIconVersion(app.id);
}

/**
 * Gives apps without a drawn icon their generated one, one at a time, in the background (after the server listens). Stops after
 * three failures in a row and logs that once.
 */
export async function backfillIcons(core: Core, log: (message: string, error?: unknown) => void = console.error): Promise<void> {
  let failures = 0;
  for (const app of core.apps.listAllApps()) {
    if (core.icons.has(app.id)) continue;
    try {
      await ensureDefaultIcon(core, app, 'backfill');
      failures = 0;
    } catch (e) {
      if (++failures >= 3) { log('Stopped drawing icons for existing apps after three failures in a row:', e); return; }
    }
  }
}

const isIconInvalid = (e: unknown): e is LagerError => e instanceof LagerError && e.reason === 'icon_invalid';

/**
 * Deploys, then does the icon work (which needs the async renderer) for MCP and REST alike. A new app without `iconSvg` gets
 * a generated icon and a warning; a redeploy without it keeps the icon. An icon that is refused never fails the deploy: the
 * previous or generated icon stays and the result says why.
 */
export async function deployWithIcon(core: Core, user: User, input: {
  slug: string; html: string; title?: string; note?: string; capabilities?: Capabilities;
  iconSvg?: string; description?: string; themeColor?: string;
}): Promise<object> {
  if (input.iconSvg !== undefined && typeof input.iconSvg !== 'string') throw new LagerError('invalid_argument', 'icon_svg must be a string.');
  const prior = core.apps.getApp(input.slug);
  const declared = input.capabilities?.complete?.model;
  // Someone who may not deploy this app learns that from the deploy itself, not from a model check that cannot help them.
  if (declared !== undefined && (!prior || core.access.canDeploy(prior, user))) assertModelAllowed(core, user, declared);
  const result = core.apps.deploy({
    slug: input.slug, html: input.html, title: input.title, note: input.note, capabilities: input.capabilities, userId: user.id,
    // Counted by `deploy` itself, only when it creates a version: a refused deploy costs nobody anything.
    rateLimit: (key) => core.deployLimiter.hit(key),
    description: input.description, themeColor: input.themeColor,
  });
  let app = result.app;
  const warnings = [...result.warnings];
  if (declared !== undefined && app.aiModelId !== null && app.aiModelId !== declared) {
    warnings.push(`The app's chosen model "${app.aiModelId}" applies instead of the declared "${declared}". Call set_app_model with null to follow the declaration.`);
  }
  // The deploy is committed by now: whatever goes wrong with the icon is reported, never turned into a failed deploy.
  try {
    let drawn = false;
    if (input.iconSvg !== undefined) {
      await core.icons.ready();
      try {
        await core.icons.set(app.id, input.iconSvg, app.themeColor, user.id);
        app = core.apps.bumpIconVersion(app.id);
        drawn = true;
      } catch (e) {
        if (!isIconInvalid(e)) throw e;
        warnings.push(`${e.message} ${core.icons.has(app.id) ? 'The previous icon stays.' : 'A generated icon is used instead.'}`);
      }
    }
    if (!core.icons.has(app.id)) {
      app = await ensureDefaultIcon(core, app, user.id);
      if (input.iconSvg === undefined) warnings.push(NO_ICON_WARNING);
    } else if (!drawn && prior && prior.themeColor !== app.themeColor) {
      app = await redrawIcon(core, app, user.id);
    }
  } catch (e) {
    console.error(e);
    warnings.push(`The icon could not be stored (${e instanceof Error ? e.message : String(e)}); the deploy itself succeeded. Try set_app_icon again.`);
    app = core.apps.getApp(app.id) ?? app;
  }
  return describeDeploy(core, user, { ...result, app, warnings });
}

export const MAX_EDITS = 100;

/**
 * How often `needle` occurs in `text` (overlapping matches included: `aa` in `aaa` is ambiguous, not unique) and where the
 * first match starts. Stops counting at 2, so each edit scans the text at most once.
 */
function occurrences(text: string, needle: string): { count: number; first: number } {
  const first = text.indexOf(needle);
  if (first === -1) return { count: 0, first };
  return { count: text.indexOf(needle, first + 1) === -1 ? 1 : 2, first };
}

/**
 * Applies text replacements to the latest deployed version and deploys the result as a new version, so an assistant can change
 * a large app without sending all of it again. The edits apply in order, each to the text the previous ones left, and each
 * `oldText` must occur exactly once there; any failed edit fails the whole call and nothing is deployed. `baseVersion` must
 * be the latest deployed version (else `conflict`), so edits written against code someone has since replaced are never
 * applied to it. The check and the deploy run without an `await` between them, so no other deploy can come in between.
 * The base version's capabilities are kept unless new ones are given.
 */
export async function editVersion(core: Core, user: User, input: {
  slug: string; baseVersion: number; edits: Array<{ oldText: string; newText: string }>; note?: string; capabilities?: Capabilities;
}): Promise<object> {
  const app = appBySlug(core, input.slug);
  if (!core.access.canDeploy(app, user)) throw new LagerError('forbidden', `You are not allowed to deploy "${app.slug}".`);
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new LagerError('invalid_argument', 'Give at least one edit.');
  if (input.edits.length > MAX_EDITS) throw new LagerError('invalid_argument', `At most ${MAX_EDITS} edits per call.`);
  const latest = core.apps.latestDeployedVersion(app.id);
  if (!latest || latest.number !== input.baseVersion) {
    throw new LagerError('conflict', `Version ${input.baseVersion} is not the latest deployed version of "${app.slug}"${latest ? ` (that is version ${latest.number})` : ''}. Read the latest one with get_version and write the edits against it.`, 'base_version');
  }
  let html = core.apps.readVersionHtml(app.id, latest.number);
  input.edits.forEach((edit, i) => {
    const which = `Edit ${i + 1}`;
    if (typeof edit?.oldText !== 'string' || typeof edit.newText !== 'string') throw new LagerError('invalid_argument', `${which}: old_text and new_text must be strings.`);
    if (edit.oldText === '') throw new LagerError('invalid_argument', `${which}: old_text must not be empty.`);
    const { count, first } = occurrences(html, edit.oldText);
    if (count !== 1) {
      throw new LagerError('invalid_argument', count === 0
        ? `${which}: old_text was not found${i > 0 ? ' in the text the earlier edits left' : ''}. Copy it exactly from get_version, including spaces and line breaks. Nothing was deployed.`
        : `${which}: old_text occurs more than once; include more of the surrounding text so it matches exactly once. Nothing was deployed.`);
    }
    html = html.slice(0, first) + edit.newText + html.slice(first + edit.oldText.length);
  });
  return deployWithIcon(core, user, { slug: app.slug, html, note: input.note, capabilities: input.capabilities ?? latest.capabilities });
}

/** An app may ask only for a catalog model that the AI group of the person deploying or choosing it allows. */
function assertModelAllowed(core: Core, user: User, model: string): void {
  if (core.ai.mayUse(user.id, model)) return;
  throw new LagerError('invalid_argument', `The model "${model}" is not available to you. Call list_models for the models you may choose, or leave the model out to use the default model of each viewer.`, 'model_not_allowed');
}

/** The models `user` may give an app, for `list_models` and the REST API. */
export function modelsJson(core: Core, user: User): object {
  return {
    models: core.ai.allowedModelsFor(user.id).map((m) => ({ name: m.id, description: m.description, provider: m.providerName, model: m.model, isDefault: m.isDefault })),
  };
}

/**
 * `set_app_model` and its REST and page counterparts: owner or collaborator, choosing among the models their own AI group
 * allows. `null` goes back to what the app's versions declare. Returns the app's model part.
 */
export function setAppModel(core: Core, user: User, app: App, model: string | null): object {
  if (!core.access.canDeploy(app, user)) throw new LagerError('forbidden', `You may not change app "${app.slug}".`);
  // Saving the current choice again is no change, even when the model is not open to this person.
  if (model !== null && model !== app.aiModelId) assertModelAllowed(core, user, model);
  return modelJson(core, core.apps.setAiModel(app.id, model));
}

/**
 * `set_app_icon` and its REST counterparts: owner or collaborator. A refused icon is an error and nothing changes.
 * Returns the app summary.
 */
export async function updateAppLook(core: Core, user: User, app: App, input: { iconSvg?: string; description?: string; themeColor?: string }): Promise<object> {
  if (input.iconSvg === undefined && input.description === undefined && input.themeColor === undefined) {
    throw new LagerError('invalid_argument', 'Give at least one of icon_svg, description and theme_color.');
  }
  if (input.iconSvg !== undefined && typeof input.iconSvg !== 'string') throw new LagerError('invalid_argument', 'icon_svg must be a string.');
  if (!core.access.canDeploy(app, user)) throw new LagerError('forbidden', `You may not change app "${app.slug}".`);
  const description = input.description === undefined ? undefined : normalizeDescription(input.description);
  const themeColor = input.themeColor === undefined ? undefined : normalizeThemeColor(input.themeColor);
  let fresh = app;
  if (input.iconSvg !== undefined) {
    await core.icons.ready();
    // Drawn before anything is stored: a refused icon changes nothing.
    await core.icons.set(app.id, input.iconSvg, themeColor ?? app.themeColor, user.id);
    fresh = core.apps.bumpIconVersion(app.id);
  }
  if (description !== undefined || themeColor !== undefined) {
    fresh = core.apps.setAppMeta(app.id, { description, themeColor }, user.id);
    if (input.iconSvg === undefined && themeColor !== undefined && themeColor !== app.themeColor) fresh = await redrawIcon(core, fresh, user.id);
  }
  fresh = await ensureDefaultIcon(core, fresh, user.id);
  return appSummary(core, user, fresh);
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

/** The HTML of one version for download: deployed versions go to those who read the app, saved ones to the managers of the saving instance. */
export function downloadableVersion(core: Core, user: User, slug: string, number: number): { html: string; version: Version } {
  const app = appBySlug(core, slug);
  const version = core.apps.listVersions(app.id).find((v) => v.number === number);
  const instance = version?.instanceId ? core.apps.getInstance(version.instanceId) : null;
  const allowed = version?.instanceId
    ? instance !== null && core.access.canManageInstance(instance, user)
    : core.access.canReadApp(app, user);
  if (!allowed) throw new LagerError('forbidden', `You have no access to version ${number} of app "${slug}".`);
  if (!version) throw new LagerError('not_found', `Version ${number} not found.`);
  return { html: core.apps.readVersionHtml(app.id, number), version };
}

/**
 * The source of one version, so a later session can continue developing an app it did not deploy: by `app` (with `version`,
 * default the latest deployed one) or by `instance` (the version active there, which may be one the instance saved itself).
 * Access is that of the HTML download. Returns the HTML and what a redeploy needs alongside it (the app's current title, the version's capabilities).
 */
export function versionSource(core: Core, user: User, input: { app?: string; version?: number; instance?: string }): {
  meta: { app: string; title: string; version: number; createdAt: string; note: string | null; sizeBytes: number; sha256: string; capabilities: Capabilities; savedByInstance: string | null };
  html: string;
} {
  if ((input.app === undefined) === (input.instance === undefined)) throw new LagerError('invalid_argument', 'Give exactly one of app or instance.');
  if (input.instance !== undefined && input.version !== undefined) throw new LagerError('invalid_argument', 'version goes with app; an instance always gives its active version.');
  let source: { html: string; version: Version };
  let app: App;
  if (input.instance !== undefined) {
    const inst = core.apps.getInstanceBySlug(input.instance);
    const found = inst ? core.apps.getApp(inst.appId) : null;
    if (!inst || !found) throw new LagerError('not_found', `Instance "${input.instance}" not found.`);
    app = found;
    // Refused in terms of the instance: the caller may not know the app, and its slug is not theirs to learn.
    const refused = new LagerError('forbidden', `You may not read the code of instance "${input.instance}" (owners and collaborators of the app, or managers of an instance that saved its own page).`);
    if (!core.access.canSeeInstance(inst, user)) throw refused;
    try {
      source = downloadableVersion(core, user, app.slug, inst.activeVersion);
    } catch (e) {
      throw e instanceof LagerError && e.code === 'forbidden' ? refused : e;
    }
  } else {
    app = appBySlug(core, input.app!);
    // An app always has a deployed version; 0 only lets downloadableVersion answer forbidden or not_found as usual.
    source = downloadableVersion(core, user, app.slug, input.version ?? core.apps.latestDeployedVersion(app.id)?.number ?? 0);
  }
  const { html, version } = source;
  const savedBy = version.instanceId ? core.apps.getInstance(version.instanceId)?.slug ?? null : null;
  return {
    meta: {
      app: app.slug, title: app.title, version: version.number, createdAt: version.createdAt, note: version.note,
      sizeBytes: version.sizeBytes, sha256: version.sha256, capabilities: version.capabilities, savedByInstance: savedBy,
    },
    html,
  };
}

/**
 * The smallest part `get_version` returns. Every part re-reads the whole version, so a tiny `limit` would turn one read into
 * thousands of full reads; a smaller `limit` is raised to this.
 */
export const MIN_PART_BYTES = 1024;

/**
 * One part of `html`, measured in UTF-8 bytes like `sizeBytes`, so that a client whose tool results are capped can read a
 * large app in several calls. A part never splits a character: it ends early instead (or, for a `limit` smaller than the
 * character at `offset`, takes that one character whole), and an `offset` inside a character is refused, so following
 * `nextOffset` from 0 returns every byte exactly once. `nextOffset` is null once the part reaches the end.
 */
export function htmlPart(html: string, offset = 0, limit?: number): { text: string; offset: number; nextOffset: number | null } {
  const bytes = Buffer.from(html, 'utf8');
  const total = bytes.length;
  if (!Number.isInteger(offset) || offset < 0 || offset > total) {
    throw new LagerError('invalid_argument', `offset must be between 0 and ${total}, the size of the HTML in bytes.`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new LagerError('invalid_argument', 'limit must be a positive whole number of bytes.');
  const continuation = (i: number): boolean => i < total && (bytes[i] & 0xc0) === 0x80;
  if (continuation(offset)) throw new LagerError('invalid_argument', `offset ${offset} lies inside a character; continue from the nextOffset of the previous part.`);
  let end = limit === undefined ? total : Math.min(total, offset + limit);
  while (end > offset && continuation(end)) end--;
  if (end === offset && offset < total) {
    end++;
    while (continuation(end)) end++;
  }
  return { text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < total ? end : null };
}

/** The app check for a signed-in publisher or administrator. */
export function runAppCheck(user: User, html: unknown, capabilities: unknown): AppCheck {
  if (user.disabled || (user.role !== 'admin' && user.role !== 'publisher')) {
    throw new LagerError('forbidden', 'Only administrators and publishers can check apps.');
  }
  if (typeof html !== 'string') throw new LagerError('invalid_argument', 'html must be a string.');
  return checkApp(html, checkCapabilities(capabilities ?? undefined));
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
  return core.apps.createInstance({ appId: app.id, slug: input.slug, ownerId: owner.id, visibility: input.visibility, createdBy: user.id });
}

// ---- custom domains (REST and MCP) -------------------------------------------

/** The instance whose domains `user` may handle: the ones they manage, and every instance for a platform administrator. */
export function domainInstance(core: Core, user: User, slug: string): Instance {
  if (user.role === 'admin' && !user.disabled) {
    const inst = core.apps.getInstanceBySlug(slug);
    if (!inst) throw new LagerError('not_found', `Instance "${slug}" not found.`);
    return inst;
  }
  return managedInstance(core, user, slug);
}

/** Attaches `host` to the instance if `user` may handle its domains; returns the instance. */
export function addDomainTo(core: Core, user: User, slug: string, host: string): Instance {
  const inst = domainInstance(core, user, slug);
  core.domains.add(inst, host, user, true);
  return inst;
}

export function removeDomainFrom(core: Core, user: User, slug: string, host: string): Instance {
  const inst = domainInstance(core, user, slug);
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
  // A declaration is an object: a capability turned on with `true` would be declared here but unavailable to the page.
  for (const [name, decl] of Object.entries(caps)) if (!isObject(decl)) bad(`${name} must be an object.`);
  if (caps.db !== undefined) {
    if (!isObject(caps.db)) bad('db must be an object.');
    const offline = (caps.db as Record<string, unknown>).offline;
    if (offline !== undefined && typeof offline !== 'boolean') bad('db.offline must be true or false.');
    const rules = (caps.db as Record<string, unknown>).rules;
    if (rules !== undefined) {
      if (!Array.isArray(rules)) bad('db.rules must be an array.');
      for (const r of rules as unknown[]) {
        if (!isObject(r) || typeof r.path !== 'string' || r.path === '') bad('every rule needs a path.');
        const rule = r as Record<string, unknown>;
        if (rule.read !== undefined && !RULE_LEVELS.includes(rule.read as string)) bad(`read must be one of ${RULE_LEVELS.join(', ')}.`);
        // `anyone` lets visitors append and nothing else, so it exists for writing only.
        if (rule.write !== undefined && rule.write !== 'anyone' && !RULE_LEVELS.includes(rule.write as string)) bad(`write must be one of ${RULE_LEVELS.join(', ')}, anyone.`);
      }
    }
  }
  if (caps.user !== undefined) {
    if (!isObject(caps.user)) bad('user must be an object.');
    const scopes = (caps.user as Record<string, unknown>).scopes;
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string'))) bad('user.scopes must be an array of strings.');
  }
  if (caps.assets !== undefined) {
    const upload = (caps.assets as Record<string, unknown>).upload;
    if (upload !== undefined && upload !== 'interact') bad('assets.upload must be "interact".');
  }
  if (caps.room !== undefined) {
    const topics = (caps.room as Record<string, unknown>).topics;
    if (topics !== undefined) {
      if (!isObject(topics)) bad('room.topics must be an object.');
      for (const [topic, level] of Object.entries(topics as Record<string, unknown>)) if (level !== 'interact') bad(`room.topics.${topic} must be "interact".`);
    }
  }
  if (caps.page !== undefined) {
    const publish = (caps.page as Record<string, unknown>).publish;
    if (publish !== undefined && typeof publish !== 'boolean') bad('page.publish must be true or false.');
  }
  if (caps.complete !== undefined) {
    const model = (caps.complete as Record<string, unknown>).model;
    if (model !== undefined && (typeof model !== 'string' || !MODEL_ID_RE.test(model))) bad('complete.model must be the name of a model from list_models.');
  }
  if (caps.ingest !== undefined) {
    try { parseIngest(caps.ingest); } catch (e) { bad(e instanceof LagerError ? e.message : 'ingest is not valid.'); }
  }
  if (caps.embed !== undefined) {
    try { parseEmbed(caps.embed); } catch (e) { bad(e instanceof LagerError ? e.message : 'embed is not valid.'); }
  }
  return caps as Capabilities;
}

// ---- tools -----------------------------------------------------------------

function result(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

const SNAPSHOT_LIMIT_NOTE = `Restores, version changes and switching auto-update on share a limit of ${SNAPSHOT_ACTIONS_PER_HOUR} per instance and hour when they take a snapshot; beyond it the answer is rate_limited.`;

function errorResult(e: unknown): CallToolResult {
  if (e instanceof LagerError) return result({ error: { code: e.code, message: e.message } }, true);
  console.error(e);
  return result({ error: { code: 'internal', message: 'Internal server error.' } }, true);
}

async function runAsync(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (e) {
    return errorResult(e);
  }
}

function run(fn: () => unknown): CallToolResult {
  try {
    return result(fn());
  } catch (e) {
    return errorResult(e);
  }
}

/**
 * db_read/db_write act with the caller's own level on the instance. The owner ignores the app's rules (to seed data); an instance
 * administrator (level `admin`) is held to them like at runtime, so rules that require `owner` stay closed. `data/users/<other>/…` is closed for everyone.
 */
export function dbAccess(core: Core, user: User, inst: Instance): { viewer: Viewer; rules: DbRule[] | undefined } {
  const level = core.access.levelFor(inst, user);
  const viewer: Viewer = { userId: user.id, level };
  if (level === 'owner') return { viewer, rules: [] };
  const caps = core.apps.getVersion(inst.appId, inst.activeVersion)?.capabilities;
  return { viewer, rules: effectiveRules(caps) };
}

/**
 * What `user` may export from and import into an instance: the owner is unrestricted, everyone else is held to the
 * active version's `db.rules` at their real level. Private areas of other users are excluded by the data store itself.
 */
export function transferAccess(core: Core, user: User, inst: Instance): { readable(path: string): boolean; writable(path: string): boolean } {
  const { viewer, rules } = dbAccess(core, user, inst);
  return { readable: (path) => canRead(rules, viewer, path), writable: (path) => canWrite(rules, viewer, path) };
}

const slugArg = z.string().describe('Slug (lowercase letters, digits, hyphens)');
const visibilityArg = z.enum(['private', 'users', 'public']);
/**
 * A JSON object with any keys. Written as an object with `additionalProperties` rather than a record, whose
 * `propertyNames` keyword some MCP clients and model providers reject in tool schemas.
 */
const jsonObject = (): z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>> => z.object({}).catchall(z.unknown());

const capabilitiesArg = z.object({
  db: jsonObject().optional().describe('Document database (lager.use("db")). Optional {"rules": [{path, read?, write?}]}'),
  user: jsonObject().optional().describe('Viewer and people (lager.use("user")). Optional {"scopes": ["email", "profile"]}'),
  assets: jsonObject().optional().describe('File uploads (lager.use("assets")). Optional {"upload": "interact"}'),
  room: jsonObject().optional().describe('Realtime rooms with presence (lager.use("room")). Optional {"topics": {"<topic>": "interact"}}'),
  page: jsonObject().optional().describe('The page saves itself (lager.use("page")). {"publish": false} disables saving'),
  downloads: jsonObject().optional().describe('Offer files to save (lager.use("downloads"))'),
  complete: jsonObject().optional().describe('Language model calls through lager.complete(). Optional {"model": "<name from list_models>"}; without it every viewer gets the default model of their AI group'),
  ingest: jsonObject().optional().describe('Receive data from outside (another website, a webhook, a script, a device): {"endpoints": [{"name", "auth": "none" | "token", "origins"?, "managedOrigins"?, "collection"?, "maxBytes"?, "maxPerDay"?, "onFull"?, "visitor"?, "country"?}]}. Each endpoint only appends documents to one collection; see "Receiving data from outside" in get_guide'),
  embed: jsonObject().optional().describe('Other websites may show the app in a frame (lager.use("embed")): {} with no fields. The people who manage each instance name the websites; see "Showing the app on other websites" in get_guide'),
}).catchall(z.unknown())
  .describe('Every runtime capability the HTML uses, e.g. {"db":{},"user":{}}. A capability that is not declared is null at runtime.');

const iconSvgArg = z.string().describe('The app icon as SVG: square viewBox="0 0 512 512", a filled background covering the whole square, one bold simple motif, shapes and paths only (no text, images, scripts or external references), under 64 KiB');
const descriptionArg = z.string().describe('One plain sentence (at most 200 characters) saying what the app does');
const themeColorArg = z.string().describe('Hex colour such as #1f2a5c that matches the icon background; used for the phone status bar and splash screen');

type ToolName =
  | 'deploy_app' | 'edit_version' | 'set_app_icon' | 'list_apps' | 'get_app' | 'get_version' | 'activate_version' | 'create_instance'
  | 'set_auto_update' | 'set_visibility' | 'share_instance' | 'unshare_instance' | 'list_shares' | 'add_domain'
  | 'remove_domain' | 'db_read' | 'db_write' | 'import_data' | 'export_data' | 'check_app' | 'list_snapshots'
  | 'restore_snapshot' | 'list_models' | 'set_app_model' | 'get_guide';

/**
 * Display titles and behaviour hints (MCP tool annotations). Clients use them to label tools and to decide which
 * calls need the user's confirmation; ChatGPT, for example, asks before every tool that is not marked read-only.
 * Every tool acts only on this Lager server (openWorldHint false).
 */
const TOOL_META: Record<ToolName, { title: string; annotations: ToolAnnotations }> = {
  deploy_app: { title: 'Deploy app', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  edit_version: { title: 'Edit app', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  set_app_icon: { title: 'Change app icon', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  list_apps: { title: 'List apps', annotations: { readOnlyHint: true } },
  get_app: { title: 'Show app', annotations: { readOnlyHint: true } },
  get_version: { title: 'Get app source', annotations: { readOnlyHint: true } },
  activate_version: { title: 'Activate version', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  create_instance: { title: 'Create instance', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  set_auto_update: { title: 'Set automatic updates', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  // Visibility and grants can withdraw access or expose data to everyone: not additive, so destructive.
  set_visibility: { title: 'Set visibility', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  share_instance: { title: 'Share instance', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  unshare_instance: { title: 'Withdraw access', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  list_shares: { title: 'List shares', annotations: { readOnlyHint: true } },
  add_domain: { title: 'Add custom domain', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  remove_domain: { title: 'Remove custom domain', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  db_read: { title: 'Read app data', annotations: { readOnlyHint: true } },
  db_write: { title: 'Write app data', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
  import_data: { title: 'Import app data', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  export_data: { title: 'Export app data', annotations: { readOnlyHint: true } },
  check_app: { title: 'Check app HTML', annotations: { readOnlyHint: true } },
  list_snapshots: { title: 'List snapshots', annotations: { readOnlyHint: true } },
  restore_snapshot: { title: 'Restore snapshot', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
  list_models: { title: 'List language models', annotations: { readOnlyHint: true } },
  set_app_model: { title: 'Choose app model', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  get_guide: { title: 'Read the Lager guide', annotations: { readOnlyHint: true } },
};

const toolMeta = (name: ToolName): { title: string; annotations: ToolAnnotations } => {
  const { title, annotations } = TOOL_META[name];
  return { title, annotations: { title, openWorldHint: false, ...annotations } };
};

export function buildMcpServer(core: Core, user: User): McpServer {
  const server = new McpServer({ name: 'lager', version: '0.2.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('deploy_app', { ...toolMeta('deploy_app'),
    description: 'Deploy an app (one self-contained HTML file) as a new version. Creates the app and its default instance on first deploy. Call get_guide once before your first deploy in a conversation: apps keep their data through the window.lager runtime it describes, never through localStorage. Pass capabilities for every runtime feature the HTML uses, and icon_svg, description and theme_color when you create an app. Returns the instance URLs, the icon URL and warnings to tell the user.',
    inputSchema: {
      slug: slugArg, html: z.string().describe('Complete HTML of the app'), title: z.string().optional().describe('Name of the app, one line of at most 100 characters'),
      capabilities: capabilitiesArg.optional(), note: z.string().optional().describe('Short version note, one line of at most 500 characters'),
      icon_svg: iconSvgArg.optional(), description: descriptionArg.optional(), theme_color: themeColorArg.optional(),
    },
  }, ({ slug, html, title, capabilities, note, icon_svg, description, theme_color }) => runAsync(() => deployWithIcon(core, user, {
    slug, html, title, note, capabilities: checkCapabilities(capabilities), iconSvg: icon_svg, description, themeColor: theme_color,
  })));

  server.registerTool('edit_version', { ...toolMeta('edit_version'),
    description: 'Change an existing app without sending all of its HTML again: replace pieces of text in the latest deployed version and deploy the result as a new version. Read the code with get_version first and copy each old_text exactly from it (spaces and line breaks included), with enough surrounding text that it occurs exactly once. The edits apply in order, each to the text the previous ones left; if any edit does not match exactly once, nothing is deployed. base_version must be the latest deployed version (get_version or get_app tells you which), otherwise the answer is conflict: someone deployed since you read the code, so read it again. The capabilities of base_version are kept unless you pass new ones. Returns the same as deploy_app.',
    inputSchema: {
      slug: slugArg, base_version: z.number().int().positive().describe('The version the edits were written against: the latest deployed version'),
      edits: z.array(z.object({
        old_text: z.string().describe('Text copied exactly from the HTML; must occur exactly once'),
        new_text: z.string().describe('What replaces it; empty deletes old_text'),
      })).min(1).max(MAX_EDITS).describe(`1 to ${MAX_EDITS} replacements, applied in order`),
      note: z.string().optional().describe('Short version note, one line of at most 500 characters'),
      capabilities: capabilitiesArg.optional().describe('Only to change them: every runtime capability the edited HTML uses. Default: those of base_version'),
    },
  }, ({ slug, base_version, edits, note, capabilities }) => runAsync(() => editVersion(core, user, {
    slug, baseVersion: base_version, note, capabilities: capabilities === undefined ? undefined : checkCapabilities(capabilities),
    edits: edits.map((e) => ({ oldText: e.old_text, newText: e.new_text })),
  })));

  server.registerTool('set_app_icon', { ...toolMeta('set_app_icon'),
    description: 'Change the icon, the description or the theme colour of one of your apps (owner or collaborator) without deploying. Give at least one field. An icon that is refused is an error and nothing changes. Icon rules are in the guide.',
    inputSchema: { app: slugArg, icon_svg: iconSvgArg.optional(), description: descriptionArg.optional(), theme_color: themeColorArg.optional() },
  }, ({ app, icon_svg, description, theme_color }) => runAsync(() => updateAppLook(core, user, appBySlug(core, app), {
    iconSvg: icon_svg, description, themeColor: theme_color,
  })));

  server.registerTool('list_apps', { ...toolMeta('list_apps'),
    description: 'List your apps (owned or collaborating) with their instances.',
    inputSchema: {},
  }, () => run(() => ({ apps: core.access.appsOf(user).map((a) => appSummary(core, user, a)) })));

  server.registerTool('get_app', { ...toolMeta('get_app'),
    description: 'Show one of your apps (owned or collaborating) with instances and all versions.',
    inputSchema: { slug: slugArg },
  }, ({ slug }) => run(() => appDetail(core, user, readableApp(core, user, slug))));

  server.registerTool('list_models', { ...toolMeta('list_models'),
    description: 'List the language models you may give an app that calls lager.complete(): name, what the administrator says each is good for, provider and model. isDefault marks the model every viewer gets when an app names none. Pick by the task: a fast, cheap model for short replies, sorting or extraction; a stronger one for long texts, reasoning or code. Declare it as capabilities {"complete": {"model": "<name>"}} or set it later with set_app_model. An empty list means no language model is available to you.',
    inputSchema: {},
  }, () => run(() => modelsJson(core, user)));

  server.registerTool('set_app_model', { ...toolMeta('set_app_model'),
    description: 'Choose the language model of an app you own or collaborate on, without a new deploy: a name from list_models, or null to follow what the app\'s versions declare in complete.model again. The choice applies to every instance of the app. Viewers whose AI group does not allow the model get the default model of their group. Returns {chosen, declared, applies}; declared and applies describe the latest deployed version, while instances on an older version follow that version\'s declaration.',
    inputSchema: { slug: slugArg, model: z.string().nullable().describe('Name from list_models, or null') },
  }, ({ slug, model }) => run(() => setAppModel(core, user, readableApp(core, user, slug), model)));

  server.registerTool('get_version', { ...toolMeta('get_version'),
    description: `Get the source of an app so you can continue developing it, e.g. in a new conversation: the complete HTML of a version plus its title and capabilities. Give app (with version, default the latest deployed one) or instance (the version active there, possibly one the page saved itself). Returns two text blocks: first JSON {app, title, version, createdAt, note, sizeBytes, sha256, capabilities, savedByInstance, offset, nextOffset}, then the raw HTML. A large app can be read in parts: pass limit (bytes, e.g. 40000; at least ${MIN_PART_BYTES}) and call again with offset set to nextOffset until nextOffset is null, then join the parts in order; an app that fits comes back whole with nextOffset null, so pass limit whenever you do not know the size (get_app lists sizeBytes per version). After the first part, always continue with app and version from its answer (not instance, and never without version), so that every part comes from the same version even if someone deploys meanwhile; if you can compute a SHA-256 (e.g. in a shell), the joined parts must match sha256, otherwise start over. Edit that HTML and redeploy it with deploy_app, passing the same capabilities (or deliberately changed ones): a deploy without capabilities declares none. Never deploy a part as if it were the whole app.`,
    inputSchema: {
      app: slugArg.optional(), version: z.number().int().positive().optional().describe('Version number from get_app, or from the first part of a read in parts; default: the latest deployed version'),
      instance: slugArg.optional().describe('Instead of app: the instance whose active version you want'),
      offset: z.number().int().nonnegative().optional().describe('Byte offset to start at, from nextOffset of the previous part; default 0'),
      limit: z.number().int().positive().optional().describe(`At most this many bytes of HTML (a part ends before a character it would split); values below ${MIN_PART_BYTES} count as ${MIN_PART_BYTES}; default: all the rest`),
    },
  }, ({ app, version, instance, offset, limit }) => {
    try {
      const { meta, html } = versionSource(core, user, { app, version, instance });
      const part = htmlPart(html, offset, limit === undefined ? undefined : Math.max(limit, MIN_PART_BYTES));
      return { content: [
        { type: 'text', text: JSON.stringify({ ...meta, offset: part.offset, nextOffset: part.nextOffset }) },
        { type: 'text', text: part.text },
      ] };
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool('activate_version', { ...toolMeta('activate_version'),
    description: `Activate any existing version on an instance (roll back or forward). A snapshot of the instance data is taken first. ${SNAPSHOT_LIMIT_NOTE}`,
    inputSchema: { instance: slugArg, version: z.number().int().positive() },
  }, ({ instance, version }) => run(() => {
    const inst = managedInstance(core, user, instance);
    return instanceJson(core, withSnapshotBudget(core, inst.id, () => core.apps.activate(inst.id, version, user.id)));
  }));

  server.registerTool('create_instance', { ...toolMeta('create_instance'),
    description: 'Create another instance of an app with its own subdomain and its own data.',
    inputSchema: {
      app: slugArg, slug: slugArg.describe('Slug of the new instance (globally unique)'), visibility: visibilityArg.optional(),
      owner_email: z.string().optional().describe('E-mail of the account that should own the instance (only for those who deploy the app); default: you'),
    },
  }, ({ app, slug, visibility, owner_email }) => run(() => instanceJson(core, createInstanceFor(core, user, { app, slug, ownerEmail: owner_email, visibility }))));

  server.registerTool('set_auto_update', { ...toolMeta('set_auto_update'),
    description: `Set whether an instance follows new deploys. Switching it on moves the instance to the latest deployed version right away (with a snapshot of the data first); switching it off pins the instance to its current version. ${SNAPSHOT_LIMIT_NOTE}`,
    inputSchema: { instance: slugArg, on: z.boolean() },
  }, ({ instance, on }) => run(() => {
    const inst = managedInstance(core, user, instance);
    return instanceJson(core, on ? withSnapshotBudget(core, inst.id, () => core.apps.setAutoUpdate(inst.id, on, user.id)) : core.apps.setAutoUpdate(inst.id, on, user.id));
  }));

  server.registerTool('set_visibility', { ...toolMeta('set_visibility'),
    description: 'Set who can open an instance: private (the owner and those it is shared with), users (all signed-in users), public (anyone).',
    inputSchema: { instance: slugArg, visibility: visibilityArg },
  }, ({ instance, visibility }) => run(() => instanceJson(core, core.apps.setVisibility(managedInstance(core, user, instance).id, visibility, user.id))));

  server.registerTool('share_instance', { ...toolMeta('share_instance'),
    description: 'Give an account (email) or a group (name) access to an instance, or change their level: view (look), interact (also write data per the app\'s rules) or admin (also manage sharing, versions and data). Exactly one of email or group is required. Returns the shares.',
    inputSchema: { instance: slugArg, email: z.string().optional(), group: z.string().optional(), level: z.enum(GRANT_LEVELS) },
  }, ({ instance, email, group, level }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const who = grantPrincipal(core, { email, group });
    core.access.setGrant(inst, who.type, who.id, level, user);
    return sharesJson(core, inst);
  }));

  server.registerTool('unshare_instance', { ...toolMeta('unshare_instance'),
    description: 'Withdraw the access of an account (email) or a group (name) from an instance. Exactly one of email or group is required. Returns the remaining shares.',
    inputSchema: { instance: slugArg, email: z.string().optional(), group: z.string().optional() },
  }, ({ instance, email, group }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const who = grantPrincipal(core, { email, group });
    core.access.removeGrant(inst, who.type, who.id, user);
    return sharesJson(core, inst);
  }));

  server.registerTool('list_shares', { ...toolMeta('list_shares'),
    description: 'Who has access to an instance: the grants (accounts and groups with their level), the visibility and the level given to all signed-in users.',
    inputSchema: { instance: slugArg },
  }, ({ instance }) => run(() => sharesJson(core, managedInstance(core, user, instance))));

  server.registerTool('add_domain', { ...toolMeta('add_domain'),
    description: 'Let an instance also answer on your own domain (a hostname such as notes.example.com). Allowed for administrators, and for publishers who manage the instance when the administrator enabled it. DNS, proxy entry and certificate for the domain are set up outside Lager; Lager does not check who owns the domain. Returns the instance with its domains.',
    inputSchema: { instance: slugArg, host: z.string().describe('Hostname without scheme, port or path') },
  }, ({ instance, host }) => run(() => instanceJson(core, addDomainTo(core, user, instance, host))));

  server.registerTool('remove_domain', { ...toolMeta('remove_domain'),
    description: 'Detach a custom domain from an instance. Returns the instance with its remaining domains.',
    inputSchema: { instance: slugArg, host: z.string() },
  }, ({ instance, host }) => run(() => instanceJson(core, removeDomainFrom(core, user, instance, host))));

  server.registerTool('db_read', { ...toolMeta('db_read'),
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
    return { docs: core.data.query(inst.id, path, spec, (p) => canRead(rules, viewer, p)) };
  }));

  server.registerTool('db_write', { ...toolMeta('db_write'),
    description: `Write instance data, e.g. to seed it after a deploy. Up to ${MAX_DB_OPS} operations, applied in order: set (replace), update (deep merge; needs read access to the path too), delete.`,
    inputSchema: {
      instance: slugArg,
      ops: z.array(z.object({
        op: z.enum(['set', 'update', 'delete']), path: z.string().describe('Document path, e.g. tasks/t1'),
        data: jsonObject().optional(),
      })).min(1).max(MAX_DB_OPS),
    },
  }, ({ instance, ops }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const { viewer, rules } = dbAccess(core, user, inst);
    // Validate every operation before applying any of them.
    for (const o of ops) {
      parseDocPath(o.path);
      if (!canWrite(rules, viewer, o.path)) throw new LagerError('forbidden', `You may not write "${o.path}" (another user's private area or a rule of the app).`);
      // A merge is size-checked as a whole and would reveal how big a document is that the caller may not read.
      if (o.op === 'update' && !canRead(rules, viewer, o.path)) throw new LagerError('forbidden', `You may not read "${o.path}", so you cannot merge into it: use set (replace) instead of update.`);
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

  server.registerTool('import_data', { ...toolMeta('import_data'),
    description: `Write many documents at once, e.g. to move the data of an existing app here: up to ${MAX_IMPORT_DOCS_MCP} {path, data} documents, all validated first and written in one transaction (existing documents are replaced). You are held to the same rules as db_write; other users' private areas cannot be written. Returns {imported}.`,
    inputSchema: {
      instance: slugArg,
      docs: z.array(z.object({ path: z.string().describe('Document path, e.g. tasks/t1'), data: jsonObject() })).min(1).max(MAX_IMPORT_DOCS_MCP),
    },
  }, ({ instance, docs }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const access = transferAccess(core, user, inst);
    for (const d of docs) {
      parseDocPath(d.path);
      if (!access.writable(d.path)) throw new LagerError('forbidden', `You may not write "${d.path}" (another user's private area or a rule of the app).`);
    }
    return core.data.importDocs(inst.id, docs, user.id, { allowPrivateOf: user.id });
  }));

  server.registerTool('export_data', { ...toolMeta('export_data'),
    description: `Read documents of an instance ordered by path, optionally only below a path prefix (the document itself and everything beneath it). At most limit documents (default ${EXPORT_DEFAULT_LIMIT}, max ${MAX_IMPORT_DOCS_MCP}); truncated says there is more, so narrow the prefix. Documents you may not read (rules, other users' private areas) are left out. Returns {docs: [{path, data}], truncated}.`,
    inputSchema: { instance: slugArg, prefix: z.string().optional(), limit: z.number().int().min(1).max(MAX_IMPORT_DOCS_MCP).optional() },
  }, ({ instance, prefix, limit }) => run(() => {
    const inst = managedInstance(core, user, instance);
    const access = transferAccess(core, user, inst);
    const base = (prefix ?? '').replace(/\/+$/, '');
    const max = limit ?? EXPORT_DEFAULT_LIMIT;
    const docs: Array<{ path: string; data: Record<string, unknown> }> = [];
    let bytes = 0;
    let truncated = false;
    const wanted = (path: string): boolean => (base === '' || path === base || path.startsWith(`${base}/`)) && access.readable(path);
    for (const d of core.data.exportDocs(inst.id, { includePrivateOf: user.id, filter: wanted })) {
      bytes += Buffer.byteLength(JSON.stringify(d.data));
      if (docs.length >= max || (docs.length > 0 && bytes > EXPORT_MAX_BYTES)) { truncated = true; break; }
      docs.push(d);
    }
    return { docs, truncated };
  }));

  server.registerTool('check_app', { ...toolMeta('check_app'),
    description: 'Check the HTML of an app before deploying it, especially one written for another host such as claude.ai: which runtime capabilities it uses via lager.use("…"), which of them Lager cannot provide (lager.use returns null), which are missing from the capabilities declaration, and warnings (browser storage, APIs of other hosts such as window.claude or window.storage that must be converted, lager.complete). Returns {used, unsupported, undeclared, warnings}.',
    inputSchema: { html: z.string(), capabilities: capabilitiesArg.optional() },
  }, ({ html, capabilities }) => run(() => runAppCheck(user, html, capabilities)));

  server.registerTool('list_snapshots', { ...toolMeta('list_snapshots'),
    description: 'List the data snapshots of an instance, newest first.',
    inputSchema: { instance: slugArg },
  }, ({ instance }) => run(() => ({ snapshots: core.data.listSnapshots(managedInstance(core, user, instance).id) })));

  server.registerTool('restore_snapshot', { ...toolMeta('restore_snapshot'),
    description: `Restore instance data from a snapshot (owner of the instance only: it rolls back all data, including what the app's rules keep from managers). The current data is saved as a snapshot first. ${SNAPSHOT_LIMIT_NOTE}`,
    inputSchema: { instance: slugArg, snapshot: z.string().describe('Snapshot id from list_snapshots') },
  }, ({ instance, snapshot }) => run(() => {
    const inst = managedInstance(core, user, instance);
    if (!core.access.canRestoreInstance(inst, user)) throw new LagerError('forbidden', `Only the owner of instance "${instance}" may restore a snapshot.`);
    withSnapshotBudget(core, inst.id, () => core.data.restore(inst.id, snapshot));
    return { restored: snapshot };
  }));

  server.registerTool('get_guide', { ...toolMeta('get_guide'),
    description: 'Read this first, before you build, change or move an app: how Lager apps are written (the window.lager runtime API for data, users, files, realtime and language-model calls), how to declare capabilities, icons, sharing, versions and limits.',
    inputSchema: {},
  }, () => result({ guide: GUIDE }));

  return server;
}
