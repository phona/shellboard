import { loadConfig } from "./config.js";
import { buildServices } from "./services.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const services = buildServices(config);
const app = await buildApp(services, { logger: true });

services.observer.start();

// Re-apply session options to sessions created before an options change.
for (const item of services.sessions.list()) {
  services.tmux.applySessionOptions(item.session.tmuxName).catch(() => {
    // dead tmux session — options apply again on restart
  });
}

await app.listen({ port: config.port, host: config.host });

async function shutdown(): Promise<void> {
  services.observer.stop();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
