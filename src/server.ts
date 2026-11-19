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
// Express also calls this with the error when listening fails; the 'error' handler below reports that.
const onListening = (err?: Error): void => {
  if (err) return;
  console.log(`Lager listening on ${config.host ?? '*'}:${config.port}, platform at ${config.publicUrl.origin}`);
  // Apps from before icons existed get their generated icon in the background; public routes serve a bundled one meanwhile.
  void backfillIcons(core);
};
const server = config.host ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);
server.on('error', (e) => {
  console.error(`Lager could not listen on ${config.host ?? '*'}:${config.port}: ${e.message}`);
  process.exit(1);
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
/** A bug that escaped every handler: say so with a timestamp, close the databases cleanly and let the supervisor restart the process. */
function crash(kind: string, err: unknown): void {
  console.error(`${new Date().toISOString()} Lager is stopping after an ${kind}:`, err);
  try { core.close(); } catch { /* the process ends either way */ }
  process.exit(1);
}
process.on('uncaughtException', (e) => crash('uncaught exception', e));
process.on('unhandledRejection', (e) => crash('unhandled rejection', e));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
