import { ADMIN_PASSWORD_PLACEHOLDER, type Config } from './config.js';
import { InstanceAssets } from './data/assets.js';
import { Hub } from './data/hub.js';
import { Rooms } from './data/rooms.js';
import { InstanceData } from './data/store.js';
import { OAuthStore } from './mcp/oauth.js';
import { Accounts } from './platform/accounts.js';
import { Access } from './platform/access.js';
import { Apps } from './platform/apps.js';
import { openPlatformDb } from './platform/db.js';
import { Groups } from './platform/groups.js';
import { createMailer, type Mailer } from './platform/mail.js';
import { Settings } from './platform/settings.js';
import { ApiTokens } from './platform/tokens.js';
import { Users } from './platform/users.js';

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
  /** Registration, e-mail verification, password reset and invitations. */
  accounts: Accounts;
  groups: Groups;
  /** Every authorization decision on apps and instances. */
  access: Access;
  close(): void;
}

export function createCore(config: Config, opts?: { mailer?: Mailer }): Core {
  const db = openPlatformDb(config.dataDir);
  const users = new Users(db);
  if (config.adminPassword === ADMIN_PASSWORD_PLACEHOLDER && config.publicUrl.protocol === 'https:' && users.count() === 0) {
    db.close();
    throw new Error('LAGER_ADMIN_PASSWORD hat noch den Platzhalter-Wert "bitte-aendern". Setze vor dem ersten Start ein eigenes Passwort, '
      + 'denn Lager ist über https öffentlich erreichbar. Das Admin-Konto wurde nicht angelegt.');
  }
  users.ensureAdmin(config.adminEmail, config.adminPassword);
  const mailer = opts?.mailer ?? createMailer(config);
  const settings = new Settings(db, { registration: mailer.enabled ? 'open' : 'invite' });
  const apps = new Apps(db, config.dataDir, users, settings);
  const tokens = new ApiTokens(db, users);
  const oauth = new OAuthStore(db, users);
  const accounts = new Accounts(db, users, settings, mailer, config);
  // Credentials do not outlive the password they were issued under; layering keeps Users free of OAuth/token code.
  users.onPasswordChanged((id) => { oauth.revokeUser(id); accounts.deleteResetLinks(id); });
  accounts.onPasswordReset((id) => { tokens.revokeAll(id); });
  users.onDisabled((id) => { oauth.revokeUser(id); });
  users.onDemoted((id) => { accounts.deleteInvitesBy(id); });
  const hub = new Hub();
  const data = new InstanceData(config.dataDir, hub, config.snapshotKeep, config.instanceQuotaBytes);
  // Pages an instance saved itself count like its documents and uploads against the one instance quota.
  const assets = new InstanceAssets(config.dataDir, config.instanceQuotaBytes, (id) => data.usage(id) + apps.savedBytes(id));
  data.setExtraUsage((id) => assets.usage(id).bytes + apps.savedBytes(id));
  apps.setQuota(config.instanceQuotaBytes, (id) => data.usage(id) + assets.usage(id).bytes);
  const groups = new Groups(db, users);
  const access = new Access(db, users, groups, apps);
  apps.setChecks({
    canDeploy: (app, userId) => { const u = users.get(userId); return u !== null && access.canDeploy(app, u); },
    canManage: (instance, userId) => { const u = users.get(userId); return u !== null && access.canManageInstance(instance, u); },
  });
  apps.onInstanceDeleted((instance) => { assets.drop(instance.id); data.trash(instance.id); });
  // Keep a restore point of the instance data whenever its active version changes.
  apps.onBeforeActivate((inst, from, to) => { data.snapshot(inst.id, `v${from}-to-v${to}`); });
  // Every open view of the instance reloads when its active version changes.
  apps.onActivated((inst) => { hub.publish(inst.id, { type: 'reload', version: inst.activeVersion }); });
  return {
    config, users, apps, data, assets, rooms: new Rooms(), hub, tokens, oauth, settings, mailer, accounts, groups, access,
    close() {
      assets.close();
      data.close();
      db.close();
    },
  };
}
