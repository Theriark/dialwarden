// The authentication service (dev-work-plan P1-A step 4): first-run setup,
// sign-in with argon2id, per-address rate limiting, TOTP with recovery codes,
// the profile and the password change. The P8 actors are the internal user
// ids (D7); the display label is resolved where a row is shown.
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ActivityService } from "../activity/service.js";
import type { Aead } from "../crypto/aead.js";
import type { Store } from "../db/store.js";
import { ApiError } from "../http/errors.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./hashing.js";
import type { LoginLimiter } from "./limiter.js";
import { otpauthUri, totpSecret, totpStep, verifyTotp } from "./totp.js";
import { users } from "../db/schema.js";
import { recoveryCodes, sessions } from "../db/schema.js";
import { randomBytes } from "node:crypto";
