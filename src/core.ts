import { ADMIN_PASSWORD_PLACEHOLDER, type Config } from './config.js';
import { Hub } from './data/hub.js';
import { InstanceData } from './data/store.js';
import { OAuthStore } from './mcp/oauth.js';
import { Apps } from './platform/apps.js';
import { openPlatformDb } from './platform/db.js';
import { ApiTokens } from './platform/tokens.js';
import { Users } from './platform/users.js';

export interface Core {
  config: Config; users: Users; apps: Apps; data: InstanceData; hub: Hub;
  /** Static API tokens (`lgr_…`). */
  tokens: ApiTokens;
  /** OAuth clients, codes and tokens for the MCP connector. */
  oauth: OAuthStore;
  close(): void;
}

export function createCore(config: Config): Core {
  const db = openPlatformDb(config.dataDir);
  const users = new Users(db);
  if (config.adminPassword === ADMIN_PASSWORD_PLACEHOLDER && config.publicUrl.protocol === 'https:' && users.count() === 0) {
    db.close();
    throw new Error('LAGER_ADMIN_PASSWORD hat noch den Platzhalter-Wert "bitte-aendern". Setze vor dem ersten Start ein eigenes Passwort, '
      + 'denn Lager ist über https öffentlich erreichbar. Das Admin-Konto wurde nicht angelegt.');
  }
  users.ensureAdmin(config.adminEmail, config.adminPassword);
  const apps = new Apps(db, config.dataDir, users);
  const tokens = new ApiTokens(db, users);
  const oauth = new OAuthStore(db, users);
  const hub = new Hub();
  const data = new InstanceData(config.dataDir, hub, config.snapshotKeep);
  // Keep a restore point of the instance data whenever its active version changes.
  apps.onBeforeActivate((inst, from, to) => { data.snapshot(inst.id, `v${from}-to-v${to}`); });
  return {
    config, users, apps, data, hub, tokens, oauth,
    close() {
      data.close();
      db.close();
    },
  };
}
