import { loadConfig } from './config.js';
import { createCore } from './core.js';
import { apiExtension } from './http/api.js';
import { dashboardExtension } from './http/dashboard.js';
import { createHttpApp } from './http/app.js';
import { mcpExtension } from './mcp/http.js';

const config = loadConfig(process.env);
let core: ReturnType<typeof createCore>;
try {
  core = createCore(config);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const app = createHttpApp(core, [apiExtension, mcpExtension, dashboardExtension]);
const server = app.listen(config.port, () => {
  console.log(`Lager listening on port ${config.port}, platform at ${config.publicUrl.origin}`);
});

function shutdown(): void {
  server.close(() => {
    core.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
