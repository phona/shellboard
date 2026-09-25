import { loadConfig } from "./config.js";
import { buildServices } from "./services.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const services = buildServices(config);
const app = await buildApp(services, { logger: true });

services.observer.start();

await app.listen({ port: config.port, host: config.host });

async function shutdown(): Promise<void> {
  services.observer.stop();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
