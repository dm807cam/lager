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
import { backfillIcons } from './mcp/tools.js';
import { mcpExtension } from './mcp/http.js';

const config = loadConfig(process.env);
let core: ReturnType<typeof createCore>;
try {
  core = createCore(config);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const app = createHttpApp(core, [staticExtension, authExtension, adminExtension, apiExtension, mcpExtension, dashboardExtension, manageExtension]);
const server = app.listen(config.port, () => {
  console.log(`Lager listening on port ${config.port}, platform at ${config.publicUrl.origin}`);
  // Apps from before icons existed get their generated icon in the background; public routes serve a bundled one meanwhile.
  void backfillIcons(core);
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
