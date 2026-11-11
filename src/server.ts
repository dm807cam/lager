import { loadConfig } from './config.js';
import { createCore } from './core.js';
import { createHttpApp } from './http/app.js';

const config = loadConfig(process.env);
const core = createCore(config);
const app = createHttpApp(core, []);
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
