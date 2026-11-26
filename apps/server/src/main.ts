// Container entry point: port 8080 (deploy/dokploy.json, Dockerfile EXPOSE).
import { buildApp } from "./app.js";

const app = await buildApp();
const { config } = app.ctx;
app.ctx.backups.start(config.backupSchedule, config.backupTimezone);
app.ctx.retention.start(config.retentionSchedule, config.retentionTimezone);
// P9-A: the scheduler (its first tick handles runs missed while the app was
// down), the background drift checks, and the demo drift job of DEMO_SEED.
app.ctx.schedules.start();
app.ctx.drift.start();
app.ctx.demoDrift.start();

const shutdown = (signal: string) => {
  app.log.info({ signal }, "shutting down");
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await app.listen({ host: config.host, port: config.port });
