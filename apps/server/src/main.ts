// Container entry point: port 8080 (deploy/dokploy.json, Dockerfile EXPOSE).
import { buildApp } from "./app.js";

const app = buildApp();

const shutdown = (signal: string) => {
  app.log.info({ signal }, "shutting down");
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await app.listen({ host: "0.0.0.0", port: 8080 });
