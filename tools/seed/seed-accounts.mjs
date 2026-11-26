#!/usr/bin/env node
// Seeds the owner of a fresh Stage instance through the setup API (dev-work-plan
// P1-A step 9, references/test-accounts.md, R&D decision THE-2141). On
// Development the owner comes from DEV_SEED_OWNER_EMAIL and
// DEV_SEED_OWNER_PASSWORD at start instead. See src/lib.mjs.
//   node tools/seed/seed-accounts.mjs \
//     --base-url https://stg-dialwarden.theriark.dev --env stage \
//     --setup-token TOKEN
// TOKEN is in DATA_DIR/setup-token or the start log of the Stage container.
// Stage is seeded after Gate 2 by the operator or the gate script, never by
// the crew.
// The admin, editor and viewer and the in-app channel (Paid), with the owner
// pair passed in and the owner password on the first line of standard input:
//   node tools/seed/seed-accounts.mjs \
//     --base-url https://dev-dialwarden.theriark.dev --env dev \
//     --team --owner-email ADDRESS --owner-password-stdin
import { main } from "./src/lib.mjs";

process.exitCode = await main(process.argv.slice(2));
