import type { Config } from './config.js';
import { Hub } from './data/hub.js';
import { InstanceData } from './data/store.js';
import { Apps } from './platform/apps.js';
import { openPlatformDb } from './platform/db.js';
import { Users } from './platform/users.js';

export interface Core { config: Config; users: Users; apps: Apps; data: InstanceData; hub: Hub; close(): void }

export function createCore(config: Config): Core {
  const db = openPlatformDb(config.dataDir);
  const users = new Users(db);
  users.ensureAdmin(config.adminEmail, config.adminPassword);
  const apps = new Apps(db, config.dataDir, users);
  const hub = new Hub();
  const data = new InstanceData(config.dataDir, hub, config.snapshotKeep);
  // Keep a restore point of the instance data whenever its active version changes.
  apps.onBeforeActivate((inst, from, to) => { data.snapshot(inst.id, `v${from}-to-v${to}`); });
  return {
    config, users, apps, data, hub,
    close() {
      data.close();
      db.close();
    },
  };
}
