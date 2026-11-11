import { loadConfig } from './config.js';
import { createCore } from './core.js';
import { adminExtension } from './http/admin.js';
import { apiExtension } from './http/api.js';
import { authExtension } from './http/auth.js';
import { dashboardExtension } from './http/dashboard.js';
import { manageExtension } from './http/manage.js';
import { staticExtension } from './http/static.js';
import { createHttpApp } from './http/app.js';
import { startTrashPurge } from './data/trash.js';
import { ensureDefaultIcon } from './mcp/tools.js';
import { mcpExtension } from './mcp/http.js';

const config = loadConfig(process.env);
let core: ReturnType<typeof createCore>;
try {
  core = createCore(config);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
// Load the renderer once, and give apps from before icons existed their generated icon.
await core.icons.ready();
for (const existing of core.apps.listAllApps()) {
  try { await ensureDefaultIcon(core, existing); } catch (e) { console.error(`Could not draw an icon for "${existing.slug}":`, e); }
}
const app = createHttpApp(core, [staticExtension, authExtension, adminExtension, apiExtension, mcpExtension, dashboardExtension, manageExtension]);
const server = app.listen(config.port, () => {
  console.log(`Lager listening on port ${config.port}, platform at ${config.publicUrl.origin}`);
});

const stopTrashPurge = startTrashPurge(config.dataDir, config.trashDays ?? 30);

function shutdown(): void {
  stopTrashPurge();
  server.close(() => {
    core.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
