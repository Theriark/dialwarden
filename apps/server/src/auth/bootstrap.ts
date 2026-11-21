// First start (R&D decision THE-2141), before the server listens:
// 1. When DEV_SEED_OWNER_EMAIL and DEV_SEED_OWNER_PASSWORD are set and no user
//    exists, the owner is created from them (unattended test and automation
//    setups; on Development the setup broker generates and registers the pair).
//    The password is never logged, returned or stored outside its hash.
// 2. While no owner exists, the setup token is ensured and printed to standard
//    output, outside pino; once an owner exists, its file is deleted.
import type { FastifyBaseLogger } from "fastify";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./hashing.js";
import { SETTING_KEYS } from "../db/settings.js";
import type { AppContext } from "../http/context.js";
import { emailSchema, newPasswordSchema } from "../http/schemas.js";

export const DEV_SEED_EMAIL = "DEV_SEED_OWNER_EMAIL";
export const DEV_SEED_PASSWORD = "DEV_SEED_OWNER_PASSWORD";

/** Creates the owner from the environment; true when it did. */
export async function bootstrapOwner(
  ctx: AppContext,
  env: NodeJS.ProcessEnv,
  log: FastifyBaseLogger,
  now: () => Date,
): Promise<boolean> {
  const email = env[DEV_SEED_EMAIL]?.trim() ?? "";
  const password = env[DEV_SEED_PASSWORD] ?? "";
  if (email === "" && password === "") {
    return false;
  }
  if (!ctx.auth.setupRequired()) {
    log.info(
      `${DEV_SEED_EMAIL} and ${DEV_SEED_PASSWORD} ignored: a user exists`,
    );
    return false;
  }
  if (!emailSchema.safeParse(email).success) {
    log.error(`${DEV_SEED_EMAIL} is not an e-mail address; no owner created`);
    return false;
  }
  if (!newPasswordSchema.safeParse(password).success) {
    log.error(
      `${DEV_SEED_PASSWORD} must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters; no owner created`,
    );
    return false;
  }
  await ctx.auth.setup({ email, password, name: "Owner" }, "bootstrap");
  ctx.settings.set(SETTING_KEYS.devSeedOwner, now().toISOString());
  log.info(`owner created from ${DEV_SEED_EMAIL} and ${DEV_SEED_PASSWORD}`);
  return true;
}

/** Opens first-run setup with the token, or closes it when an owner exists. */
export function openFirstRunSetup(
  ctx: AppContext,
  out: NodeJS.WritableStream,
): void {
  if (!ctx.auth.setupRequired()) {
    ctx.setupToken.remove();
    return;
  }
  const token = ctx.setupToken.ensure();
  const { baseUrl, port } = ctx.config;
  const origin = (baseUrl ?? `http://localhost:${port}`).replace(/\/+$/, "");
  out.write(
    `Dialwarden first-run setup: open ${origin}/setup#token=${token} (the token is also in DATA_DIR/setup-token)\n`,
  );
}
