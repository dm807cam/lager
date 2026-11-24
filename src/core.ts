import { ADMIN_PASSWORD_PLACEHOLDERS, DEFAULT_INGEST_QUOTA_BYTES, isLoopbackHost, MIN_SECRET_LENGTH, type Config } from './config.js';
import { InstanceAssets } from './data/assets.js';
import { Hub } from './data/hub.js';
import { RateLimiter } from './http/ratelimit.js';
import { Rooms } from './data/rooms.js';
import { PrivatePurge } from './data/private-purge.js';
import { InstanceData, PRIVATE_PURGE_LIMIT } from './data/store.js';
import { OAuthStore } from './mcp/oauth.js';
import { AccountRemoval } from './platform/account-removal.js';
import { Accounts } from './platform/accounts.js';
import { AiModels } from './platform/ai.js';
import { Access } from './platform/access.js';
import { Apps } from './platform/apps.js';
import { openPlatformDb } from './platform/db.js';
import { Domains } from './platform/domains.js';
import { AppIcons } from './platform/icons.js';
import { Ingest } from './platform/ingest.js';
import { Embed } from './platform/embed.js';
import { Groups } from './platform/groups.js';
import { createMailer, MailSettings, SMTP_TIMEOUT_MS, type Mailer, type MailSource } from './platform/mail.js';
import { Settings } from './platform/settings.js';
import { ApiTokens } from './platform/tokens.js';
import { MIN_PASSWORD_LENGTH, Users } from './platform/users.js';

export interface Core {
  config: Config; users: Users; apps: Apps; data: InstanceData; hub: Hub;
  /** Uploaded files per instance (the `assets` capability). */
  assets: InstanceAssets;
  /** Ephemeral events and presence between the viewers of an instance (the `room` capability); memory only. */
  rooms: Rooms;
  /** Static API tokens (`lgr_…`). */
  tokens: ApiTokens;
  /** OAuth clients, codes and tokens for the MCP connector. */
  oauth: OAuthStore;
  /** Persisted instance-wide settings (registration mode, instance limit). */
  settings: Settings;
  mailer: Mailer;
  /** The mail server saved in the administration area; LAGER_SMTP_URL takes precedence over it. */
  mailSettings: MailSettings;
  /** Where the mail server in use comes from: `env` (LAGER_SMTP_URL), `admin` (the administration area) or `none`. */
  readonly mailSource: MailSource;
  /** Registration, e-mail verification, password reset and invitations. */
  accounts: Accounts;
  /** Deleting an account for good, with what it owns handed on or deleted. */
  removal: AccountRemoval;
  /** Removes the private areas of deleted accounts from other people's instances, in the background. */
  privatePurge: PrivatePurge;
  groups: Groups;
  /** Custom hostnames that answer for an instance. */
  domains: Domains;
  /** Every authorization decision on apps and instances. */
  access: Access;
  /** The language model apps reach through `window.lager.complete` (bring your own model). */
  ai: AiModels;
  /** App icons rendered from the SVG the deploying assistant supplies. `await core.icons.ready()` before `set` or `setDefault`. */
  icons: AppIcons;
  /** New versions per app (`app:<id>`) and new apps per person (`user:<id>`) within an hour, REST and MCP together (see `Apps.deploy`). */
  deployLimiter: RateLimiter;
  /** Data that arrives from outside: the endpoints apps declare, their switches and tokens, and the limits on what comes in. */
  ingest: Ingest;
  /** The websites outside Lager that the people who manage an instance allow to show it in a frame. */
  embed: Embed;
  close(): void;
}

/**
 * One app takes this many new versions an hour, and one person may start this many new apps an hour: plenty for an assistant that
 * iterates, too few to fill the disk with versions quickly.
 */
export const DEPLOYS_PER_HOUR = 60;

export function createCore(config: Config, opts?: { mailer?: Mailer; fetch?: typeof fetch }): Core {
  const db = openPlatformDb(config.dataDir);
  const users = new Users(db);
  const fresh = users.count() === 0;
  const refuse = (message: string): never => { db.close(); throw new Error(message); };
  // The secret signs sessions and derives the key that encrypts AI provider keys. A short one is refused only while nothing depends
  // on it yet: on an installation with accounts, replacing it would sign everyone out and make the stored keys unreadable.
  if (config.weakSecret) {
    const short = `LAGER_SECRET is shorter than ${MIN_SECRET_LENGTH} characters, too short for the key that signs sessions and encrypts stored AI provider keys.`;
    if (fresh) {
      refuse(`${short} Set at least ${MIN_SECRET_LENGTH} random characters (for example the output of "openssl rand -hex 32"), or leave it empty `
        + 'and Lager generates a secret and keeps it in the data directory. Decide now: changing the secret later signs everyone out '
        + 'and makes stored AI provider keys unreadable, so they have to be entered again.');
    }
    console.warn(`WARNING: ${short} Lager keeps using it, because changing the secret signs everyone out and makes stored AI provider keys `
      + `unreadable, so they have to be entered again. Replace it with at least ${MIN_SECRET_LENGTH} random characters when that is acceptable.`);
  }
  // Checked only while the first administrator is about to be created: a later start never reads the password again.
  if (config.adminEmail && config.adminPassword !== undefined && fresh) {
    const placeholder = ADMIN_PASSWORD_PLACEHOLDERS.includes(config.adminPassword);
    if (placeholder && !isLoopbackHost(config.publicUrl.hostname)) {
      refuse(`LAGER_ADMIN_PASSWORD still has the example value "${config.adminPassword}". Set your own password before the first start, `
        + `because Lager is reachable from other machines at ${config.publicUrl.host}. The admin account was not created.`);
    }
    if (config.adminPassword.length < MIN_PASSWORD_LENGTH) {
      refuse(`LAGER_ADMIN_PASSWORD is too short: the administrator's password needs at least ${MIN_PASSWORD_LENGTH} characters. The admin account was not created.`);
    }
    if (placeholder) {
      console.warn(`WARNING: the administrator ${config.adminEmail} is created with the example password "${config.adminPassword}". `
        + 'Change it on the Account page before anyone else can reach this server.');
    }
  }
  // Without an account nobody can sign in, and only an administrator can let anyone else in: such a server would run for nothing.
  if (fresh && !(config.adminEmail && config.adminPassword)) {
    refuse('This Lager has no account yet, and the first administrator cannot be created: set both LAGER_ADMIN_EMAIL and '
      + `LAGER_ADMIN_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) for the first start. The password line can be removed afterwards.`);
  }
  users.ensureAdmin(config.adminEmail, config.adminPassword);
  const mailSettings = new MailSettings(db, config.secret);
  const mailer = opts?.mailer ?? createMailer(config, SMTP_TIMEOUT_MS, mailSettings);
  const settings = new Settings(db, { registration: mailer.enabled ? 'open' : 'invite' });
  const apps = new Apps(db, config.dataDir, users, settings);
  const tokens = new ApiTokens(db, users);
  const oauth = new OAuthStore(db, users);
  const accounts = new Accounts(db, users, settings, mailer, config);
  // Credentials do not outlive the password they were issued under; layering keeps Users free of OAuth/token code.
  users.onPasswordChanged((id) => { oauth.revokeUser(id); tokens.revokeAll(id); accounts.deleteResetLinks(id); });
  users.onDisabled((id) => { oauth.revokeUser(id); });
  users.onDemoted((id) => { accounts.deleteInvitesBy(id); });
  const icons = new AppIcons(config.dataDir);
  const ai = new AiModels(db, config.secret, opts?.fetch, config.aiTimeoutSeconds === undefined ? undefined : config.aiTimeoutSeconds * 1000);
  const hub = new Hub();
  const ingestQuotaBytes = config.ingestQuotaBytes ?? DEFAULT_INGEST_QUOTA_BYTES;
  const data = new InstanceData(config.dataDir, hub, config.snapshotKeep, config.instanceQuotaBytes, undefined, ingestQuotaBytes);
  // Pages an instance saved itself count like its documents and uploads against the one instance quota.
  const assets = new InstanceAssets(config.dataDir, config.instanceQuotaBytes, (id) => data.usage(id) + apps.savedBytes(id));
  data.setExtraUsage((id) => assets.usage(id).bytes + apps.savedBytes(id));
  apps.setQuota(config.instanceQuotaBytes, (id) => data.usage(id) + assets.usage(id).bytes);
  const groups = new Groups(db, users);
  const access = new Access(db, users, groups, apps);
  const domains = new Domains(db, config, settings);
  apps.setChecks({
    canDeploy: (app, userId) => { const u = users.get(userId); return u !== null && access.canDeploy(app, u); },
    canManage: (instance, userId) => { const u = users.get(userId); return u !== null && access.canManageInstance(instance, u); },
  });
  // A platform at <label>.<apps domain> answers on that host itself, so an instance of that name could never be reached.
  const appsSuffix = `.${config.appsDomain.toLowerCase()}`;
  const platformHost = config.publicUrl.hostname.toLowerCase();
  if (platformHost.endsWith(appsSuffix)) apps.reserveSlug(platformHost.slice(0, -appsSuffix.length));
  // The host names go first and on their own: they are rows, and files that cannot be moved must not leave a domain pointing at nothing.
  apps.onInstanceDeleted((instance) => { domains.removeAll(instance.id); });
  apps.onInstanceDeleted((instance) => { assets.drop(instance.id); });
  apps.onInstanceDeleted((instance) => { data.trash(instance.id); });
  // Keep a restore point of the instance data whenever its active version changes.
  apps.onBeforeActivate((inst, from, to) => { data.snapshot(inst.id, `v${from}-to-v${to}`); });
  // Every open view of the instance reloads when its active version changes.
  apps.onActivated((inst) => { hub.publish(inst.id, { type: 'reload', version: inst.activeVersion }); });
  const ingest = new Ingest(db, config.secret, ingestQuotaBytes, config.countryHeader);
  ingest.setDefault((instanceId) => {
    const instance = apps.getInstance(instanceId);
    const owner = instance ? users.get(instance.ownerId) : null;
    const app = instance ? apps.getApp(instance.appId) : null;
    return owner !== null && app !== null && access.canReadApp(app, owner);
  });
  apps.onInstanceDeleted((instance) => { ingest.forget(instance.id); });
  const removal = new AccountRemoval(db, users, apps);
  // The private area of a deleted account in other people's instances is closed to everyone else, yet counts against their
  // quota: it goes with the account. Every instance is looked at, since any that was open to the account may hold one; that
  // takes a while with many instances, so it happens after the administrator has the answer (see `PrivatePurge`).
  const privatePurge = new PrivatePurge((instanceId, userId) => data.purgePrivateArea(instanceId, userId), PRIVATE_PURGE_LIMIT);
  removal.onRemoved((userId) => { privatePurge.start(userId, apps.listAllInstances().map((instance) => instance.id)); });
  return {
    config, users, apps, data, assets, rooms: new Rooms(), hub, tokens, oauth, settings, mailer, mailSettings,
    get mailSource(): MailSource { return config.smtpUrl ? 'env' : mailSettings.get() ? 'admin' : 'none'; },
    accounts, groups, domains, access,
    icons, ai, removal, privatePurge, deployLimiter: new RateLimiter(DEPLOYS_PER_HOUR, 3600_000), ingest,
    embed: new Embed(db, config, domains),
    close() {
      // First: a pass that is under way must not open a database again after they were closed.
      privatePurge.stop();
      icons.close();
      assets.close();
      data.close();
      db.close();
    },
  };
}
