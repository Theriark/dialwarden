// Shared API schemas. Field names of the entitlement are contract C1.
import {
  FEATURE_KEYS,
  LICENCE_STATES,
  type FeatureKey,
} from "@dialwarden/entitlement";
import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../auth/hashing.js";
import { MIN_PASSPHRASE_LENGTH, PASSPHRASE_CHARS } from "../backup/archive.js";

export const emailSchema = z.email().max(254);

export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .max(MAX_PASSWORD_LENGTH);

/** A password being checked (any length the policy ever allowed). */
export const passwordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);

/**
 * A backup passphrase: printable ASCII only, for export and import alike (the
 * import reads it from a header, which Node decodes as latin1).
 */
export const passphraseSchema = z
  .string()
  .min(MIN_PASSPHRASE_LENGTH)
  .max(1024)
  .regex(PASSPHRASE_CHARS, "printable ASCII characters only");

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  /**
   * The role the user acts with now: the stored role on Paid, viewer for
   * every user but the owner on the Free fallback (P8-A step 8). The stored
   * role is in GET /api/v1/users.
   */
  role: z.string(),
  totpEnabled: z.boolean(),
});

export const signedInSchema = z.object({
  status: z.literal("ok"),
  user: userSchema,
  csrfToken: z.string(),
});

const stateSchema = z.enum(LICENCE_STATES);
const limitValue = z.number().int().nullable();

const featureShape = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, z.boolean()]),
) as Record<FeatureKey, z.ZodBoolean>;
const featuresSchema = z.object(featureShape);

export const entitlementSchema = z.object({
  plan: z.enum(["free", "paid"]),
  state: stateSchema,
  source: z.enum(["none", "ui", "environment"]),
  limits: z.object({
    servers: limitValue,
    users: limitValue,
    historyVisible: limitValue,
    presets: limitValue,
  }),
  features: featuresSchema,
  licence: z
    .object({
      lidHash8: z.string().nullable(),
      last6: z.string(),
      customerName: z.string().nullable(),
      kind: z.enum(["customer", "internal-dev"]).nullable(),
      issuedAt: z.string().nullable(),
      updatesUntil: z.string().nullable(),
      warn30: z.boolean(),
    })
    .nullable(),
  envLicence: z.object({
    present: z.boolean(),
    state: stateSchema,
    ignored: z.boolean(),
  }),
  buildDate: z.string().nullable(),
  featureBaseline: z.string().nullable(),
});

export const okSchema = z.object({ status: z.literal("ok") });
